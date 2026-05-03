import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join, dirname, resolve as resolvePath, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
// Initialize Sentry early (before other imports that might throw)
import {
  initSentry,
  setSentryUser,
  captureException,
  addBreadcrumb,
} from './services/sentry';
initSentry();
import { coreServices } from './services/core';
import {
  LoginWithPinInputSchema,
  CreateUserInputSchema,
  UpdateUserInputSchema,
  DeleteUserInputSchema,
  SetPrinterInputSchema,
  CreateMenuCategoryInputSchema,
  UpdateMenuCategoryInputSchema,
  CreateMenuItemInputSchema,
  UpdateMenuItemInputSchema,
  TransferTableInputSchema,
} from '@shared/ipc';
import {
  clearCloudAdminSession,
  clearCloudSessionForSender,
  cloudJson,
  getCloudAccessPassword,
  getCloudConfig,
  getCloudSessionUserId,
  hasCloudSession,
  hasCloudSessionForSender,
  setCloudSession,
  setCloudSessionForSender,
  setCloudToken,
} from './services/cloud';
import {
  enqueueOutbox,
  getOutboxStatus,
  isLikelyOfflineError,
  startOutboxLoop,
} from './services/offlineOutbox';
import {
  setupAutoUpdater,
  updaterHandlers,
  registerUpdateListener,
  cleanup as cleanupUpdater,
} from './updater';
import {
  checkRateLimit,
  cleanupSenderRateLimits,
  logSecurityEvent,
  sanitizeString,
  validatePin,
  sanitizeNumber,
  getSecurityLog,
} from './services/security';
import {
  startMemoryMonitoring,
  stopMemoryMonitoring,
  getMemoryStats,
  exportMemorySnapshot,
  getMemoryUsage,
  formatMemoryUsage,
} from './services/memoryMonitor';
import {
  buildEscposTicket,
  buildHtmlReceipt,
  classifyPrinterError,
  printHtmlToSystemPrinter,
  sendToCupsRawPrinter,
  sendToPrinterVerbose,
} from './print';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';
import { startApiServer } from './api';
import { startPrinterStationLoop } from './services/printerStation';
import { transferTableLocal } from './services/tableTransfer';
import {
  startNotificationRetentionLoop,
  stopNotificationRetentionLoop,
} from './services/notificationRetention';
import {
  syncUsersFromCloud,
  syncFromCloudAfterLogin,
  syncFromCloudManual,
} from './services/cloudSync';

dotenv.config();

async function cloudEnabledButMissingBusinessCode(): Promise<boolean> {
  try {
    const s = await coreServices.readSettings().catch(() => null as any);
    const backendUrl = String((s as any)?.cloud?.backendUrl || '').trim();
    const businessCode = String((s as any)?.cloud?.businessCode || '').trim();
    return Boolean(backendUrl && !businessCode);
  } catch {
    return false;
  }
}

const MAIN_FILE = fileURLToPath(import.meta.url);
const MAIN_DIR = dirname(MAIN_FILE);
// When bundled, most main code runs from `dist/main/chunks/*`.
// We want paths relative to `dist/main` so preload + renderer resolve correctly.
const MAIN_RUNTIME_DIR =
  basename(MAIN_DIR) === 'chunks' ? resolvePath(MAIN_DIR, '..') : MAIN_DIR;
const PRELOAD_PATH = join(MAIN_RUNTIME_DIR, '../preload/index.cjs');
const RENDERER_INDEX_HTML = join(MAIN_RUNTIME_DIR, '../renderer/index.html');
// App icon: resolve from project root (dev) or packaged resources
const APP_ICON_PATH = (() => {
  // In dev: project root / build-resources / icon.png
  // In prod: process.resourcesPath or app path
  const candidates = [
    join(app.getAppPath(), 'build-resources', 'icon.png'),
    join(MAIN_RUNTIME_DIR, '../../build-resources/icon.png'),
    join(process.cwd(), 'build-resources', 'icon.png'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return undefined;
})();

let mainWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;
let kdsWindow: BrowserWindow | null = null;

function broadcastPrinterEvent(payload: any) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send('printer:event', payload);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

async function getSqliteDbFilePath(): Promise<string | null> {
  try {
    const rows = (await (prisma as any).$queryRawUnsafe(
      'PRAGMA database_list;',
    )) as any[];
    const main = Array.isArray(rows)
      ? rows.find((r) => String(r?.name || r?.[1] || '') === 'main')
      : null;
    const file = String(main?.file ?? main?.[2] ?? '');
    if (!file) return null;
    return resolvePath(file);
  } catch {
    // Fallback: attempt to parse DATABASE_URL
    try {
      const u = String(process.env.DATABASE_URL || '').trim();
      if (u.startsWith('file:')) {
        const p = u.replace(/^file:/, '');
        return resolvePath(p);
      }
    } catch {
      // ignore
    }
    return null;
  }
}

function getBackupsDir(): string {
  return join(app.getPath('userData'), 'backups');
}

function ensureDir(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

function backupFileName(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `pos-backup-${y}${m}${d}-${hh}${mm}${ss}.db`;
}

async function createDbBackupNow(): Promise<{
  ok: boolean;
  file?: string;
  error?: string;
}> {
  const dbPath = await getSqliteDbFilePath();
  if (!dbPath) return { ok: false, error: 'Could not locate database file' };
  const dir = getBackupsDir();
  ensureDir(dir);
  const dest = join(dir, backupFileName());

  try {
    // Best effort to checkpoint WAL into the main db file.
    try {
      await (prisma as any).$executeRawUnsafe(
        'PRAGMA wal_checkpoint(TRUNCATE);',
      );
    } catch {
      // ignore
    }

    // Prefer a consistent backup (SQLite 3.27+)
    try {
      await (prisma as any).$executeRawUnsafe(
        `VACUUM INTO '${dest.replace(/'/g, "''")}';`,
      );
      return { ok: true, file: dest };
    } catch {
      // fallback to file copy
    }

    fs.copyFileSync(dbPath, dest);
    return { ok: true, file: dest };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Backup failed') };
  }
}

function listDbBackups(): Array<{
  file: string;
  name: string;
  bytes: number;
  createdAt: string;
}> {
  const dir = getBackupsDir();
  ensureDir(dir);
  const out: Array<{
    file: string;
    name: string;
    bytes: number;
    createdAt: string;
  }> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.db'))) {
    const file = join(dir, name);
    try {
      const st = fs.statSync(file);
      out.push({
        file,
        name,
        bytes: st.size,
        createdAt: st.mtime.toISOString(),
      });
    } catch {
      // ignore
    }
  }
  // newest first
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

async function restoreDbBackup(
  name: string,
): Promise<{ ok: boolean; error?: string; devRestartRequired?: boolean }> {
  const dir = getBackupsDir();
  ensureDir(dir);
  const safeName = String(name || '').replace(/[^0-9A-Za-z._-]/g, '');
  if (!safeName.endsWith('.db'))
    return { ok: false, error: 'Invalid backup file' };
  const src = join(dir, safeName);
  if (!fs.existsSync(src)) return { ok: false, error: 'Backup not found' };
  const dbPath = await getSqliteDbFilePath();
  if (!dbPath) return { ok: false, error: 'Could not locate database file' };

  try {
    // Safety backup before restore
    await createDbBackupNow().catch(() => null);
    await prisma.$disconnect().catch(() => null);
    fs.copyFileSync(src, dbPath);
    // Relaunch so Prisma and all in-memory state reload cleanly.
    // In dev (`npm run dev`), electron-vite won't auto-relaunch the app, so we return a hint.
    if (app.isPackaged) {
      app.relaunch();
      app.exit(0);
      return { ok: true };
    }
    // Give IPC a moment to respond so UI can show a message, then exit.
    setTimeout(() => app.exit(0), 250);
    return { ok: true, devRestartRequired: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Restore failed') };
  }
}

function shouldForceLogoutOnError(e: any) {
  const msg = String(e?.message || e || '').toLowerCase();
  return msg.includes('unauthorized') || msg.includes('not logged in');
}

function forceLogoutSender(sender: any, reason: string) {
  try {
    sender?.send?.('auth:forceLogout', { reason });
  } catch {
    // ignore
  }
}

let __kdsSchemaReady: boolean | null = null;
let __kdsLastError: string | null = null;

async function ensureKdsLocalSchema() {
  if (__kdsSchemaReady === true) return true;
  // Best-effort: in dev/prod the DB might be behind migrations; make KDS self-healing.
  try {
    // If this works, schema exists.
    await (prisma as any).kdsDayCounter.count();
    __kdsSchemaReady = true;
    __kdsLastError = null;
    return true;
  } catch {
    // continue
  }
  try {
    // 1) MenuItem.station (sqlite doesn't support IF NOT EXISTS for ALTER TABLE; ignore errors)
    try {
      await (prisma as any).$executeRawUnsafe(
        `ALTER TABLE "MenuItem" ADD COLUMN "station" TEXT NOT NULL DEFAULT 'KITCHEN';`,
      );
    } catch {
      // ignore
    }

    // 2) KDS tables (idempotent)
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsDayCounter" ("dayKey" TEXT NOT NULL PRIMARY KEY, "lastNo" INTEGER NOT NULL DEFAULT 0);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsOrder" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "dayKey" TEXT NOT NULL, "orderNo" INTEGER NOT NULL, "area" TEXT NOT NULL, "tableLabel" TEXT NOT NULL, "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "closedAt" DATETIME);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "KdsOrder_dayKey_orderNo_key" ON "KdsOrder"("dayKey","orderNo");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsOrder_area_tableLabel_closedAt_idx" ON "KdsOrder"("area","tableLabel","closedAt");`,
    );

    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsTicket" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "orderId" INTEGER NOT NULL, "userId" INTEGER, "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "itemsJson" JSONB NOT NULL, "note" TEXT, CONSTRAINT "KdsTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "KdsOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "KdsTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsTicket_orderId_firedAt_idx" ON "KdsTicket"("orderId","firedAt");`,
    );

    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsTicketStation" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "ticketId" INTEGER NOT NULL, "station" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'NEW', "bumpedAt" DATETIME, "bumpedById" INTEGER, CONSTRAINT "KdsTicketStation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KdsTicket" ("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "KdsTicketStation_bumpedById_fkey" FOREIGN KEY ("bumpedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "KdsTicketStation_ticketId_station_key" ON "KdsTicketStation"("ticketId","station");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsTicketStation_station_status_bumpedAt_idx" ON "KdsTicketStation"("station","status","bumpedAt");`,
    );

    __kdsSchemaReady = true;
    __kdsLastError = null;
    return true;
  } catch {
    __kdsSchemaReady = false;
    __kdsLastError = 'Failed to ensure KDS schema.';
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111827',
    ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(RENDERER_INDEX_HTML);
  }

  mainWindow.webContents.on('did-fail-load', (_e, ec, ed, vu) => {
    console.error('Renderer failed load', { ec, ed, vu });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Register for update notifications
  registerUpdateListener(mainWindow);
}

function createAdminWindow() {
  if (adminWindow) {
    adminWindow.focus();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    backgroundColor: '#111827',
    title: 'Admin -  Code Orbit POS',
    ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH,
    },
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) adminWindow.loadURL(url + '#/admin');
  else
    adminWindow.loadFile(RENDERER_INDEX_HTML, {
      hash: '/admin',
    });
  adminWindow.on('closed', () => {
    cleanupSenderRateLimits(adminWindow?.id || 0);
    adminWindow = null;
  });

  // Register for update notifications
  registerUpdateListener(adminWindow);
}

function createKdsWindow() {
  if (kdsWindow) {
    kdsWindow.focus();
    return;
  }
  kdsWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#111827',
    title: 'Kitchen Display -  Code Orbit POS',
    ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH,
    },
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) kdsWindow.loadURL(url + '#/kds');
  else
    kdsWindow.loadFile(RENDERER_INDEX_HTML, {
      hash: '/kds',
    });
  kdsWindow.on('closed', () => {
    kdsWindow = null;
  });
}

function startKdsAutoBumpLoop() {
  // Auto-bump stale KDS tickets so they don't sit in NEW forever (e.g. forgotten open tables).
  // Requirement: bump anything left open for > 12 hours.
  const cutoffMs = 12 * 60 * 60 * 1000;
  const intervalMs = 60 * 60 * 1000; // hourly

  const runOnce = async () => {
    const ok = await ensureKdsLocalSchema().catch(() => false);
    if (!ok) return;
    const cutoff = new Date(Date.now() - cutoffMs);
    const now = new Date();
    try {
      await (prisma as any).kdsTicketStation.updateMany({
        where: { status: 'NEW', ticket: { firedAt: { lt: cutoff } } },
        data: { status: 'DONE', bumpedAt: now },
      });
    } catch {
      // ignore
    }
  };

  void runOnce();
  setInterval(() => void runOnce(), intervalMs);
}

function startAutoVoidStaleTicketsLoop() {
  // Auto-void any *open* tables whose session exceeds 12 hours.
  // This helps avoid "ghost" open tickets after long downtime and keeps KDS clean.
  const cutoffMs = 12 * 60 * 60 * 1000;
  const intervalMs = 60 * 60 * 1000; // hourly
  const reason = 'Auto-void: ticket exceeded 12 hours';

  const runOnce = async () => {
    try {
      const keyOpen = 'tables:open';
      const openRow = await prisma.syncState
        .findUnique({ where: { key: keyOpen } })
        .catch(() => null);
      const openMap = ((openRow?.valueJson as any) || {}) as Record<
        string,
        boolean
      >;

      const keyAt = 'tables:openAt';
      const atRow = await prisma.syncState
        .findUnique({ where: { key: keyAt } })
        .catch(() => null);
      const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;

      const keyClosedOverride = 'tables:closedOverride';
      const closedRow = await prisma.syncState
        .findUnique({ where: { key: keyClosedOverride } })
        .catch(() => null);
      const closedOverride = ((closedRow?.valueJson as any) || {}) as Record<
        string,
        string
      >;

      const now = Date.now();
      const staleKeys = Object.entries(atMap)
        .filter(([k, iso]) => {
          if (!openMap[k]) return false;
          const t = iso ? new Date(iso).getTime() : NaN;
          if (!Number.isFinite(t)) return false;
          return now - t > cutoffMs;
        })
        .map(([k]) => k);

      if (staleKeys.length === 0) return;

      for (const k of staleKeys) {
        const [area, tableLabel] = String(k).split(':');
        if (!area || !tableLabel) continue;

        // Find an actor userId for local mirroring/audit (use last ticket owner if possible).
        const last = await prisma.ticketLog
          .findFirst({
            where: { area, tableLabel },
            orderBy: { createdAt: 'desc' },
          })
          .catch(() => null as any);
        const actorUserId = Number(last?.userId || 0) || 0;

        // Local-first: cancel pending/approved requests for this stale table.
          try {
            const nowDt = new Date();
            const rows = await prisma.ticketRequest
              .findMany({
                where: {
                  area,
                  tableLabel,
                  status: { in: ['PENDING', 'APPROVED'] as any },
                },
                select: { id: true, requesterId: true, ownerId: true },
                take: 200,
              } as any)
              .catch(() => []);
            if (rows.length) {
              await prisma.ticketRequest
                .updateMany({
                  where: {
                    area,
                    tableLabel,
                    status: { in: ['PENDING', 'APPROVED'] as any },
                  },
                  data: { status: 'REJECTED' as any, decidedAt: nowDt },
                } as any)
                .catch(() => null);
              const msg = `Auto-cancelled add-item requests on ${area} ${tableLabel}: ticket exceeded 12 hours`;
              const usersToNotify = new Set<number>();
              for (const r of rows as any[]) {
                usersToNotify.add(Number(r.requesterId));
                usersToNotify.add(Number(r.ownerId));
              }
              const admins = await prisma.user
                .findMany({
                  where: { role: 'ADMIN', active: true },
                  select: { id: true },
                } as any)
                .catch(() => []);
              for (const a of admins as any[]) usersToNotify.add(Number(a.id));
              for (const uid of usersToNotify) {
                if (!uid) continue;
                await prisma.notification
                  .create({
                    data: {
                      userId: uid,
                      type: 'OTHER' as any,
                      message: msg,
                    } as any,
                  })
                  .catch(() => {});
              }
            }
          } catch {
            // ignore
          }

        // Close table locally (open map + openAt) so UI immediately turns green.
        try {
          await coreServices.setTableOpen(area, tableLabel, false);
        } catch {
          // ignore
        }
        try {
          delete atMap[`${area}:${tableLabel}`];
          await prisma.syncState
            .upsert({
              where: { key: keyAt },
              create: { key: keyAt, valueJson: atMap },
              update: { valueJson: atMap },
            })
            .catch(() => null);
        } catch {
          // ignore
        }

        // Override: if table was force-closed, hide from UI until state is consistent.
        try {
          closedOverride[`${area}:${tableLabel}`] = new Date().toISOString();
          await prisma.syncState
            .upsert({
              where: { key: keyClosedOverride },
              create: { key: keyClosedOverride, valueJson: closedOverride },
              update: { valueJson: closedOverride },
            })
            .catch(() => null);
        } catch {
          // ignore
        }

        // Mirror locally: mark latest ticket items voided + note reason (best-effort).
        try {
          if (last) {
            const itemsArr = ((last.itemsJson as any[]) || []).map(
              (it: any) => ({ ...it, voided: true }),
            );
            const note2 = last.note
              ? `${last.note} | VOIDED: ${reason}`
              : `VOIDED: ${reason}`;
            await prisma.ticketLog
              .update({
                where: { id: last.id },
                data: { itemsJson: itemsArr, note: note2 },
              })
              .catch(() => null);
          }
        } catch {
          // ignore
        }

        // Local notifications:
        // - In local mode this is the admin panel feed.
        // - In cloud mode the admin panel feed is cloud-backed, but the void-ticket API call will create a notification there.
        if (!cloud && actorUserId) {
          const msg = `Auto-voided ticket on ${area} ${tableLabel}: exceeded 12 hours`;
          await prisma.notification
            .create({
              data: { userId: actorUserId, type: 'OTHER' as any, message: msg },
            })
            .catch(() => {});
        }

        // KDS is always local: reflect void + close order immediately.
        try {
          if (actorUserId)
            await applyKdsVoidTicket({
              userId: actorUserId,
              area,
              tableLabel,
              reason,
            }).catch(() => false);
          const active = await (prisma as any).kdsOrder
            .findFirst({
              where: { area, tableLabel, closedAt: null },
              orderBy: { openedAt: 'desc' },
            })
            .catch(() => null);
          if (active)
            await (prisma as any).kdsOrder
              .update({
                where: { id: active.id },
                data: { closedAt: new Date() },
              })
              .catch(() => null);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  };

  void runOnce();
  setInterval(() => void runOnce(), intervalMs);
}

app.whenReady().then(async () => {
  // Set macOS dock icon (BrowserWindow icon doesn't affect dock on macOS)
  if (process.platform === 'darwin' && APP_ICON_PATH) {
    try {
      const { nativeImage } = await import('electron');
      const img = nativeImage.createFromPath(APP_ICON_PATH);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {
      // ignore — dock icon stays default
    }
  }
  createWindow();
  setupAutoUpdater();
  await startApiServer();
  // In cloud mode, also act as an on-prem Printer Station (pull queued print jobs and print locally).
  startPrinterStationLoop();
  // Offline outbox: retry queued cloud writes when connectivity returns.
  startOutboxLoop();
  // Notifications: automatically delete notifications older than 1 week (DB retention).
  startNotificationRetentionLoop(prisma, { days: 7 });
  // KDS: auto-bump stale tickets after 12 hours.
  startKdsAutoBumpLoop();
  // Tickets: auto-void stale open tables after 12 hours + notify.
  startAutoVoidStaleTicketsLoop();
  // Memory monitoring: track memory usage to detect leaks (runs every minute)
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.MEMORY_MONITORING === 'true'
  ) {
    startMemoryMonitoring(60000); // Check every minute
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cleanupUpdater();
  stopMemoryMonitoring();
  stopNotificationRetentionLoop();
});

// Updater IPC handlers
ipcMain.handle('updater:getStatus', async () => {
  return updaterHandlers.getUpdateStatus();
});

ipcMain.handle('updater:checkForUpdates', async () => {
  return await updaterHandlers.checkForUpdates();
});

ipcMain.handle('updater:downloadUpdate', async () => {
  return await updaterHandlers.downloadUpdate();
});

ipcMain.handle('updater:installUpdate', async () => {
  return updaterHandlers.installUpdate();
});

// Global error handlers for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  captureException(error, { type: 'uncaughtException' });
  // Don't exit - let Electron handle it (it may show a dialog)
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  const error = reason instanceof Error ? reason : new Error(String(reason));
  captureException(error, {
    type: 'unhandledRejection',
    promise: String(promise),
  });
});

// IPC Handlers (skeleton with validation)
ipcMain.handle('auth:loginWithPin', async (_e, payload) => {
  // Login is intentionally NOT rate-limited on the local POS terminal.
  // Waiters retype PINs frequently throughout a shift and getting locked out
  // mid-service is worse than a brute-force risk on a physically supervised
  // device. We still log every attempt below via security events so failed
  // logins remain auditable.
  const { pin, userId } = LoginWithPinInputSchema.parse(payload);

  // Validate PIN format (but don't reject weak PINs during login - users may already have them)
  const pinValidation = validatePin(pin, false); // rejectWeak = false for login
  if (!pinValidation.valid) {
    logSecurityEvent('invalid_pin_format', { senderId: _e.sender.id, userId });
    throw new Error(pinValidation.error || 'Invalid PIN format');
  }

  // Local-first: try local DB for auth
  const where: any = userId ? { id: userId, active: true } : { active: true };
  const user = await prisma.user.findFirst({ where });
  if (user) {
    const ok = await bcrypt.compare(pin, user.pinHash);
    if (ok) {
      const userData = {
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        active: user.active,
        createdAt: user.createdAt.toISOString(),
      };
      setSentryUser(user.id, user.displayName, user.role);
      addBreadcrumb('User logged in', 'auth', 'info');
      return userData;
    }
    // record a security notification for the targeted user
    await prisma.notification
      .create({
        data: {
          userId: user.id,
          type: 'SECURITY' as any,
          message: 'Wrong PIN attempt on your account',
        },
      })
      .catch(() => {});
  }

  // Local failed: try cloud login when cloud is configured (sync data on success)
  const cfg = await getCloudConfig().catch(() => null);
  if (cfg && user?.externalId) {
    const cloudUserId = Number(user.externalId);
    if (Number.isFinite(cloudUserId)) {
      try {
        const loginRes = await cloudJson<{ user: any; token: string }>(
          'POST',
          '/auth/login',
          {
            businessCode: cfg.businessCode,
            pin,
            userId: cloudUserId,
          }
        );
        if (loginRes?.token && loginRes?.user) {
          const session = {
            token: loginRes.token,
            businessCode: cfg.businessCode,
            role: loginRes.user.role,
            userId: loginRes.user.id,
          };
          setCloudSession(session);
          setCloudSessionForSender(_e.sender.id, session);
          await syncFromCloudAfterLogin(
            loginRes.token,
            loginRes.user.id,
            pin
          );
          const userData = {
            id: user.id,
            displayName: user.displayName,
            role: user.role,
            active: user.active,
            createdAt: user.createdAt.toISOString(),
          };
          setSentryUser(user.id, user.displayName, user.role);
          addBreadcrumb('User logged in via cloud (synced to local)', 'auth', 'info');
          return userData;
        }
      } catch {
        // Cloud login failed, fall through to return null
      }
    }
  }

  return null;
});

ipcMain.handle('auth:verifyManagerPin', async (_e, payload) => {
  const pin = String((payload as any)?.pin || '').trim();
  // Validate format (but don't reject weak PINs during verification - managers may already have them)
  const pinValidation = validatePin(pin, false); // rejectWeak = false for verification
  if (!pinValidation.valid) return { ok: false };

  // Suspicious-pattern alerting (local): repeated manager PIN failures from the same window/sender.
  // Conservative thresholds + neutral wording to avoid false accusations.
  const windowMinutes = 10;
  const threshold = 10;
  const cooldownMinutes = 60;
  const senderId = Number(_e.sender.id || 0);
  const now = Date.now();
  // Map is attached to global to avoid duplicate instances in dev reloads.
  const g: any = globalThis as any;
  if (!g.__mgrPinFailBySender) g.__mgrPinFailBySender = new Map();
  const failMap: Map<number, { count: number; resetAt: number; lastAlertAt: number }> =
    g.__mgrPinFailBySender;
  const cur = failMap.get(senderId);
  if (!cur || cur.resetAt <= now) {
    failMap.set(senderId, { count: 0, resetAt: now + windowMinutes * 60 * 1000, lastAlertAt: cur?.lastAlertAt || 0 });
  }
  // Local-first: always use local DB for manager PIN verification
  const admins = await prisma.user
    .findMany({
      where: { role: 'ADMIN', active: true },
      orderBy: { id: 'asc' },
    })
    .catch(() => []);
  for (const u of admins as any[]) {
    const ok = await bcrypt
      .compare(pin, String((u as any).pinHash || ''))
      .catch(() => false);
    if (ok) {
      // Success resets the counter
      const st = failMap.get(senderId);
      if (st) failMap.set(senderId, { ...st, count: 0 });
      // Local-only short-lived approval token to prevent spoofing approvals.
      const g2: any = globalThis as any;
      if (!g2.__approvalTokensLocal) g2.__approvalTokensLocal = new Map();
      const tokMap: Map<string, { userId: number; role: string; exp: number }> =
        g2.__approvalTokensLocal;
      const token = crypto.randomBytes(24).toString('base64url');
      tokMap.set(token, {
        userId: (u as any).id,
        role: 'ADMIN',
        exp: Date.now() + 5 * 60 * 1000,
      });
      return {
        ok: true,
        userId: (u as any).id,
        userName: (u as any).displayName,
        approvalToken: token,
      };
    }
  }
  // Failure
  const st = failMap.get(senderId)!;
  st.count += 1;
  failMap.set(senderId, st);
  if (st.count >= threshold && (!st.lastAlertAt || now - st.lastAlertAt > cooldownMinutes * 60 * 1000)) {
    const msg =
      `Unusual activity (auto-check): ${st.count} manager PIN verification failures in the last ${windowMinutes} minutes. ` +
      `This can be normal (mistyped PINs); please review if unexpected.`;
    for (const a of admins as any[]) {
      await prisma.notification.create({ data: { userId: (a as any).id, type: 'SECURITY' as any, message: msg } as any }).catch(() => {});
    }
    st.lastAlertAt = now;
    failMap.set(senderId, st);
  }
  return { ok: false };
});

ipcMain.handle('auth:logoutAdmin', async (_e) => {
  // Clear any cloud session (used for cloud backup feature)
  clearCloudAdminSession();
  clearCloudSessionForSender(_e.sender.id);
  forceLogoutSender(_e.sender, 'logout');
  return true;
});

ipcMain.handle('auth:createUser', async (_e, payload) => {
  // Rate limit user creation (admin only)
  if (
    !checkRateLimit(_e, 'auth:createUser', {
      maxAttempts: 20,
      windowMs: 60 * 1000,
    })
  ) {
    logSecurityEvent('ipc_rate_limit_exceeded', {
      handler: 'auth:createUser',
      senderId: _e.sender.id,
    });
    throw new Error('Too many requests. Please slow down.');
  }

  const input = CreateUserInputSchema.parse(payload);

  // Validate PIN format
  if (input.pin) {
    const pinValidation = validatePin(input.pin);
    if (!pinValidation.valid) {
      logSecurityEvent('invalid_pin_format', {
        handler: 'auth:createUser',
        senderId: _e.sender.id,
      });
      throw new Error(pinValidation.error || 'Invalid PIN format');
    }
  }

  // Sanitize display name
  const sanitizedDisplayName = sanitizeString(input.displayName, 80);
  if (!sanitizedDisplayName) {
    throw new Error('Display name is required');
  }
  // Local-first: always use local DB for user creation
  // - Allow creating the very first user only if it's an ADMIN (initial setup).
  // - After that, only allow user creation from the admin window.
  const userCount = await prisma.user.count().catch(() => 0);
  if (userCount === 0) {
    if (String(input.role || '').toUpperCase() !== 'ADMIN') {
      throw new Error('forbidden');
    }
  } else {
    const adminSenderId = adminWindow?.webContents?.id;
    if (!adminSenderId || _e.sender.id !== adminSenderId) {
      throw new Error('forbidden');
    }
  }

  const pinHash = await bcrypt.hash(input.pin, 10);
  const created = await prisma.user.create({
    data: {
      displayName: input.displayName,
      role: input.role,
      pinHash,
      active: input.active ?? true,
    },
  });
  return {
    id: created.id,
    displayName: created.displayName,
    role: created.role,
    active: created.active,
    createdAt: created.createdAt.toISOString(),
  };
});

ipcMain.handle('auth:listUsers', async (_e, payload) => {
  // Local-first: use local DB for users
  let users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
  // When local is empty and cloud is configured, sync users from cloud first
  if (users.length === 0) {
    const cfg = await getCloudConfig().catch(() => null);
    if (cfg) {
      const syncResult = await syncUsersFromCloud();
      if (syncResult.error) {
        addBreadcrumb(`Cloud user sync failed: ${syncResult.error}`, 'auth', 'warning');
      }
      users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    }
  }
  const includeAdmins = (payload as any)?.includeAdmins !== false;
  const filtered = includeAdmins
    ? users
    : users.filter((u: any) => u.role !== 'ADMIN');
  return filtered.map((u: any) => ({
    id: u.id,
    displayName: u.displayName,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt.toISOString(),
  }));
});

ipcMain.handle('auth:updateUser', async (_e, payload) => {
  // Rate limit user updates (admin only)
  if (
    !checkRateLimit(_e, 'auth:updateUser', {
      maxAttempts: 20,
      windowMs: 60 * 1000,
    })
  ) {
    logSecurityEvent('ipc_rate_limit_exceeded', {
      handler: 'auth:updateUser',
      senderId: _e.sender.id,
    });
    throw new Error('Too many requests. Please slow down.');
  }

  const input = UpdateUserInputSchema.parse(payload);

  // Validate PIN format if provided
  if (input.pin) {
    const pinValidation = validatePin(input.pin);
    if (!pinValidation.valid) {
      logSecurityEvent('invalid_pin_format', {
        handler: 'auth:updateUser',
        senderId: _e.sender.id,
        userId: input.id,
      });
      throw new Error(pinValidation.error || 'Invalid PIN format');
    }
  }

  // Sanitize display name if provided
  const sanitizedInput: any = { ...input };
  if (input.displayName) {
    const sanitized = sanitizeString(input.displayName, 80);
    if (!sanitized) {
      throw new Error('Display name cannot be empty');
    }
    sanitizedInput.displayName = sanitized;
  }

  // Log user update (security audit)
  logSecurityEvent('user_updated', {
    senderId: _e.sender.id,
    userId: input.id,
    fields: Object.keys(input),
  });

  // Local-first: always use local DB for user updates
  let pinHash: string | undefined;
  if (sanitizedInput.pin) pinHash = await bcrypt.hash(sanitizedInput.pin, 10);
  const updated = await prisma.user.update({
    where: { id: input.id },
    data: {
      ...(sanitizedInput.displayName
        ? { displayName: sanitizedInput.displayName }
        : {}),
      ...(sanitizedInput.role ? { role: sanitizedInput.role } : {}),
      ...(typeof sanitizedInput.active === 'boolean'
        ? { active: sanitizedInput.active }
        : {}),
      ...(pinHash ? { pinHash } : {}),
    },
  });
  return {
    id: updated.id,
    displayName: updated.displayName,
    role: updated.role,
    active: updated.active,
    createdAt: updated.createdAt.toISOString(),
  };
});

ipcMain.handle('auth:deleteUser', async (_e, payload) => {
  const input = DeleteUserInputSchema.parse(payload);
  const id = Number(input.id);
  if (!id) throw new Error('invalid user id');

  // Local-first: always use local DB for user delete/disable
  if (!input.hard) {
    await prisma.user.update({ where: { id }, data: { active: false } });
    return true;
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return true;

  // Safety: don't remove the last active admin
  if (user.role === 'ADMIN' && user.active) {
    const otherActiveAdmins = await prisma.user.count({
      where: { role: 'ADMIN' as any, active: true, id: { not: id } } as any,
    });
    if (otherActiveAdmins <= 0)
      throw new Error('cannot delete the last active admin');
  }

  // Safety: only allow hard delete when the user has no history
  const [
    orders,
    tickets,
    notifications,
    shiftsOpened,
    shiftsClosed,
    reqMade,
    reqOwned,
  ] = await Promise.all([
    prisma.order.count({ where: { userId: id } }),
    prisma.ticketLog.count({ where: { userId: id } }),
    prisma.notification.count({ where: { userId: id } }),
    prisma.dayShift.count({ where: { openedById: id } }),
    prisma.dayShift.count({ where: { closedById: id } }),
    prisma.ticketRequest.count({ where: { requesterId: id } }),
    prisma.ticketRequest.count({ where: { ownerId: id } }),
  ]);
  const total =
    orders +
    tickets +
    notifications +
    shiftsOpened +
    shiftsClosed +
    reqMade +
    reqOwned;
  if (total > 0)
    throw new Error('user has history; disable instead of deleting');

  await prisma.user.delete({ where: { id } });
  return true;
});

// Shifts IPC - Local-first: always use local DB
ipcMain.handle('shifts:getOpen', async (_e, { userId }) => {
  const open = await prisma.dayShift.findFirst({
    where: { closedAt: null, openedById: userId },
  });
  return open
    ? {
        id: open.id,
        openedAt: open.openedAt.toISOString(),
        closedAt: open.closedAt?.toISOString() ?? null,
        openedById: open.openedById,
        closedById: open.closedById ?? null,
      }
    : null;
});

ipcMain.handle('shifts:clockIn', async (_e, { userId }) => {
  const already = await prisma.dayShift.findFirst({
    where: { closedAt: null, openedById: userId },
  });
  if (already)
    return {
      id: already.id,
      openedAt: already.openedAt.toISOString(),
      closedAt: null,
      openedById: already.openedById,
      closedById: already.closedById ?? null,
    };
  const created = await prisma.dayShift.create({
    data: { openedById: userId, totalsJson: {} } as any,
  });
  return {
    id: created.id,
    openedAt: created.openedAt.toISOString(),
    closedAt: null,
    openedById: created.openedById,
    closedById: created.closedById ?? null,
  };
});

ipcMain.handle('shifts:clockOut', async (_e, { userId }) => {
  const open = await prisma.dayShift.findFirst({
    where: { closedAt: null, openedById: userId },
  });
  if (!open) return null;
  const updated = await prisma.dayShift.update({
    where: { id: open.id },
    data: { closedAt: new Date(), closedById: userId },
  });
  return {
    id: updated.id,
    openedAt: updated.openedAt.toISOString(),
    closedAt: updated.closedAt?.toISOString() ?? null,
    openedById: updated.openedById,
    closedById: updated.closedById ?? null,
  };
});

ipcMain.handle('shifts:listOpen', async (_e) => {
  const open = await prisma.dayShift.findMany({ where: { closedAt: null } });
  return open.map((s: { openedById: number }) => s.openedById);
});

// Sync staff from external API and upsert into local users
ipcMain.handle('auth:syncStaffFromApi', async (_e, raw) => {
  const url: string =
    (raw?.url as string) ||
    process.env.STAFF_API_URL ||
    'https:// Code Orbit-agroturizem.com/api/staff';
  // Cache: skip network if synced within 10 minutes
  const staffLast = await prisma.syncState.findUnique({
    where: { key: 'staff:lastSync' },
  });
  const staffTs = staffLast?.valueJson
    ? Number((staffLast.valueJson as any).ts)
    : 0;
  if (Date.now() - staffTs < 10 * 60 * 1000) {
    const users = await prisma.user.findMany({});
    return users.length;
  }
  let res: any;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' } as any,
    } as any);
  } catch {
    return (await prisma.user.count()) || 0; // network failure: silently fallback
  }
  if (!res.ok) {
    // Upstream 5xx: keep existing staff, update lastSync to avoid loops for a short period
    await prisma.syncState.upsert({
      where: { key: 'staff:lastSync' },
      create: { key: 'staff:lastSync', valueJson: { ts: Date.now() } },
      update: { valueJson: { ts: Date.now() } },
    });
    return (await prisma.user.count()) || 0;
  }
  const body = await res.json();
  const staff = Array.isArray(body?.data) ? body.data : [];
  let count = 0;
  for (const s of staff) {
    if (s.isActive === false) continue;
    const fullName = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
    const pin = String(s.posPin ?? '').trim();
    if (!pin) continue;
    const pinHash = await bcrypt.hash(pin, 10);
    const existing = await prisma.user.findFirst({
      where: { externalId: s.id },
    });
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { displayName: fullName, pinHash, active: true },
      });
    } else {
      await prisma.user.create({
        data: {
          displayName: fullName || 'Staff',
          role: 'WAITER',
          pinHash,
          active: true,
          externalId: s.id,
        },
      });
    }
    count += 1;
  }
  await prisma.syncState.upsert({
    where: { key: 'staff:lastSync' },
    create: { key: 'staff:lastSync', valueJson: { ts: Date.now() } },
    update: { valueJson: { ts: Date.now() } },
  });
  return count;
});

async function readSettings() {
  const base = await coreServices.readSettings();
  const dbAreas = await prisma.area
    .findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } })
    .catch(() => []);
  const tableAreas = (dbAreas as any[]).length
    ? (dbAreas as any[]).map((a) => ({ name: a.name, count: a.defaultCount }))
    : (base.tableAreas ?? [
        {
          name: 'Main Hall',
          count: process.env.TABLE_COUNT_MAIN_HALL
            ? Number(process.env.TABLE_COUNT_MAIN_HALL)
            : 8,
        },
        {
          name: 'Terrace',
          count: process.env.TABLE_COUNT_TERRACE
            ? Number(process.env.TABLE_COUNT_TERRACE)
            : 4,
        },
      ]);
  const result: any = { ...base, tableAreas };
  // Never expose API secret to renderer
  if (result?.security && typeof result.security === 'object') {
    result.security = { ...result.security };
    delete result.security.apiSecret;
  }
  // Never expose cloud access password to renderer. Admin can re-enter it if needed.
  if (result?.cloud && typeof result.cloud === 'object') {
    result.cloud = { ...result.cloud };
    delete result.cloud.accessPassword;
  }
  return result;
}

ipcMain.handle('settings:get', async () => {
  return await readSettings();
});

ipcMain.handle('settings:update', async (_e, input) => {
  // If cloud is enabled, validate business code + access password before persisting.
  // This prevents saving wrong values and then having a confusing "no users" login screen.
  try {
    const envCloudUrl = String(process.env.POS_CLOUD_URL || '').trim();
    const nextCodeRaw = String(
      (input as any)?.cloud?.businessCode || '',
    ).trim();
    const nextPwRaw = String(
      (input as any)?.cloud?.accessPassword || '',
    ).trim();
    if (envCloudUrl && (nextCodeRaw || nextPwRaw)) {
      const businessCode = nextCodeRaw
        .replace(/[^0-9A-Za-z_-]/g, '')
        .toUpperCase()
        .slice(0, 24);
      if (!businessCode) throw new Error('Business code is required.');
      if (nextPwRaw.length < 6)
        throw new Error('Business password is required (min 6 chars).');
      // Verify against cloud by attempting to list users (admin must always exist for a tenant).
      const url = `${envCloudUrl.replace(/\/+$/g, '')}/auth/public-users?businessCode=${encodeURIComponent(businessCode)}&includeAdmins=1`;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10_000);
      const r = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-business-password': nextPwRaw,
        } as any,
        signal: ac.signal,
      } as any).finally(() => clearTimeout(t));
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        const errText = String((data as any)?.error || '').trim();
        // Common operational issue: cloud backend was deployed but Cloud SQL migrations were not applied.
        // Prisma then throws "column does not exist" for newly added fields.
        if (/does not exist/i.test(errText) && /business\./i.test(errText)) {
          throw new Error(
            'Cloud backend database is missing migrations. Ask the provider to run: `cd server && npx prisma migrate deploy` against the Cloud SQL DATABASE_URL.',
          );
        }
        throw new Error(
          errText || 'Invalid Business code or Business password.',
        );
      }
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Invalid Business code or Business password.');
      }
      // Normalize the code back into the input so it is stored consistently.
      (input as any).cloud = { ...((input as any).cloud || {}), businessCode };
    }
  } catch (e: any) {
    const msg = String(e?.name || '')
      .toLowerCase()
      .includes('abort')
      ? 'Cloud backend timed out. Check your internet connection and try again.'
      : String(e?.message || e || 'Invalid cloud settings');
    throw new Error(msg);
  }
  // Merge and persist in SyncState, so admin changes survive restarts
  const merged = await coreServices.updateSettings(input);
  // Also reflect table areas into Area table if provided
  if (Array.isArray((input as any).tableAreas)) {
    const areas = (input as any).tableAreas as {
      name: string;
      count: number;
    }[];
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i];
      await prisma.area.upsert({
        where: { name: a.name },
        create: { name: a.name, defaultCount: a.count, sortOrder: i },
        update: { defaultCount: a.count, sortOrder: i, active: true },
      });
    }
    // Deactivate others not in list
    const names = areas.map((a) => a.name);
    await prisma.area.updateMany({
      where: { name: { notIn: names } },
      data: { active: false },
    });
  }
  return merged;
});

ipcMain.handle('network:getIps', async () => {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    const list = nets[name] || [];
    for (const ni of list) {
      if (!ni) continue;
      if (ni.family !== 'IPv4') continue;
      if (ni.internal) continue;
      ips.push(ni.address);
    }
  }
  // Prefer stable ordering
  return Array.from(new Set(ips)).sort((a, b) => a.localeCompare(b));
});

ipcMain.handle('settings:setPrinter', async (_e, payload) => {
  const _ = SetPrinterInputSchema.parse(payload);
  const current = await readSettings();
  const merged = { ...current, printer: { ...current.printer, ..._ } } as any;
  await prisma.syncState.upsert({
    where: { key: 'settings' },
    create: { key: 'settings', valueJson: merged },
    update: { valueJson: merged },
  });
  return merged;
});

ipcMain.handle('settings:testPrint', async () => {
  try {
    const settings = await readSettings();
    const mode = (settings.printer?.mode ||
      (settings.printer?.serialPath
        ? 'SERIAL'
        : settings.printer?.deviceName
          ? 'SYSTEM'
          : 'NETWORK')) as any;
    if (mode === 'SYSTEM') {
      // Default ON: most receipt printers should receive raw ESC/POS (HTML/PostScript prints as "code")
      const raw = (settings.printer as any)?.systemRawEscpos !== false;
      if (raw) {
        const data = Buffer.from(
          [
            '\x1b@',
            ' Code Orbit POS Test Print\n',
            '-------------------------\n',
            new Date().toISOString() + '\n\n',
            '\x1dV\x41\x10',
          ].join(''),
          'binary',
        );
        const r = await sendToCupsRawPrinter({
          deviceName: settings.printer?.deviceName,
          data,
        });
        return r.ok;
      } else {
        const html = buildHtmlReceipt(
          {
            area: 'TEST',
            tableLabel: 'USB',
            covers: null,
            items: [{ name: 'Test item', qty: 1, unitPrice: 1.0, vatRate: 0 }],
            note: null,
            userName: 'POS',
            meta: { vatEnabled: true },
          },
          settings as any,
        );
        const r = await printHtmlToSystemPrinter({
          html,
          deviceName: settings.printer?.deviceName,
          silent: settings.printer?.silent !== false,
        });
        return r.ok;
      }
    }
    if (mode === 'SERIAL') {
      const p = settings.printer || {};
      const cfg = {
        path: String((p as any).serialPath || ''),
        baudRate: Number((p as any).baudRate || 19200),
        dataBits: (Number((p as any).dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
        stopBits: (Number((p as any).stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
        parity: String((p as any).parity || 'none') as any as
          | 'none'
          | 'even'
          | 'odd',
      };
      if (!cfg.path) throw new Error('Serial port not configured');
      const data = Buffer.from(
        [
          '\x1b@',
          ' Code Orbit POS Test Print\n',
          '-------------------------\n',
          new Date().toISOString() + '\n\n',
          '\x1dV\x41\x10',
        ].join(''),
        'binary',
      );
      const { sendToSerialPrinter } = await import('./serial');
      const r = await sendToSerialPrinter(cfg as any, data);
      return r.ok;
    }
    const ip = process.env.PRINTER_IP || settings.printer?.ip;
    const port = Number(
      process.env.PRINTER_PORT || settings.printer?.port || 9100,
    );
    if (!ip) throw new Error('Printer IP not configured');
    const data = Buffer.from(
      [
        '\x1b@',
        ' Code Orbit POS Test Print\n',
        '-------------------------\n',
        new Date().toISOString() + '\n\n',
        '\x1dV\x41\x10',
      ].join(''),
      'binary',
    );
    const r = await sendToPrinterVerbose(ip, port, data);
    if (!r.ok) {
      const c = classifyPrinterError(r.error);
      broadcastPrinterEvent({
        level: 'error',
        kind: c.kind,
        message: c.userMessage,
        detail: r.error,
        at: Date.now(),
      });
    }
    return r.ok;
  } catch {
    return false;
  }
});

ipcMain.handle('settings:testPrintVerbose', async () => {
  try {
    const settings = await readSettings();
    const mode = (settings.printer?.mode ||
      (settings.printer?.serialPath
        ? 'SERIAL'
        : settings.printer?.deviceName
          ? 'SYSTEM'
          : 'NETWORK')) as any;
    if (mode === 'SYSTEM') {
      // Default ON: most receipt printers should receive raw ESC/POS (HTML/PostScript prints as "code")
      const raw = (settings.printer as any)?.systemRawEscpos !== false;
      if (raw) {
        const data = Buffer.from(
          [
            '\x1b@',
            ' Code Orbit POS Test Print\n',
            '-------------------------\n',
            new Date().toISOString() + '\n\n',
            '\x1dV\x41\x10',
          ].join(''),
          'binary',
        );
        const r = await sendToCupsRawPrinter({
          deviceName: settings.printer?.deviceName,
          data,
        });
        return r.ok
          ? { ok: true }
          : { ok: false, error: r.error || 'CUPS raw print failed' };
      } else {
        const html = buildHtmlReceipt(
          {
            area: 'TEST',
            tableLabel: 'USB',
            covers: null,
            items: [{ name: 'Test item', qty: 1, unitPrice: 1.0, vatRate: 0 }],
            note: null,
            userName: 'POS',
            meta: { vatEnabled: true },
          },
          settings as any,
        );
        const r = await printHtmlToSystemPrinter({
          html,
          deviceName: settings.printer?.deviceName,
          silent: settings.printer?.silent !== false,
        });
        return r.ok
          ? { ok: true }
          : { ok: false, error: r.error || 'System print failed' };
      }
    }
    if (mode === 'SERIAL') {
      const p = settings.printer || {};
      const cfg = {
        path: String((p as any).serialPath || ''),
        baudRate: Number((p as any).baudRate || 19200),
        dataBits: (Number((p as any).dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
        stopBits: (Number((p as any).stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
        parity: String((p as any).parity || 'none') as any as
          | 'none'
          | 'even'
          | 'odd',
      };
      if (!cfg.path) return { ok: false, error: 'Serial port not configured' };
      const data = Buffer.from(
        [
          '\x1b@',
          ' Code Orbit POS Test Print\n',
          '-------------------------\n',
          new Date().toISOString() + '\n\n',
          '\x1dV\x41\x10',
        ].join(''),
        'binary',
      );
      const { sendToSerialPrinter } = await import('./serial');
      const r = await sendToSerialPrinter(cfg as any, data);
      return r.ok
        ? { ok: true }
        : { ok: false, error: r.error || 'Serial print failed' };
    }
    const ip = process.env.PRINTER_IP || settings.printer?.ip;
    const port = Number(
      process.env.PRINTER_PORT || settings.printer?.port || 9100,
    );
    if (!ip) return { ok: false, error: 'Printer IP not configured' };
    const data = Buffer.from(
      [
        '\x1b@',
        ' Code Orbit POS Test Print\n',
        '-------------------------\n',
        new Date().toISOString() + '\n\n',
        '\x1dV\x41\x10',
      ].join(''),
      'binary',
    );
    const r = await sendToPrinterVerbose(ip, port, data);
    if (!r.ok) {
      const c = classifyPrinterError(r.error);
      broadcastPrinterEvent({
        level: 'error',
        kind: c.kind,
        message: c.userMessage,
        detail: r.error,
        at: Date.now(),
      });
    }
    return r.ok
      ? { ok: true }
      : {
          ok: false,
          error:
            r.error ||
            `Send failed (protocol ${process.env.PRINTER_PROTOCOL || (port === 515 ? 'LPR' : 'RAW')} to ${ip}:${port})`,
        };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Unknown error') };
  }
});

ipcMain.handle('printer:list', async (e) => {
  const list = await e.sender.getPrintersAsync();
  return (list || []).map((p: any) => ({
    name: p.name,
    isDefault: Boolean(p.isDefault),
    status: typeof p.status === 'number' ? p.status : undefined,
    description: p.description ? String(p.description) : undefined,
  }));
});

ipcMain.handle('printer:listSerialPorts', async () => {
  try {
    const { listSerialPorts } = await import('./serial');
    return await listSerialPorts();
  } catch (e: any) {
    // Most common: serialport native bindings not rebuilt for Electron yet.
    console.warn('[Printer] listSerialPorts failed:', e?.message || e);
    return [];
  }
});

ipcMain.handle('offline:getStatus', async () => {
  // Return outbox status for the UI indicator (only count items ready to sync, not waiting for retry)
  return await getOutboxStatus();
});

ipcMain.handle('system:openExternal', async (_e, payload) => {
  try {
    const url = String((payload as any)?.url || '').trim();
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('billing:getStatus', async (_e) => {
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud) {
    return { status: 'ACTIVE', billingEnabled: false };
  }
  try {
    return await cloudJson('GET', '/billing/status', undefined, {
      requireAuth: true,
      senderId: _e.sender.id,
    });
  } catch (e: any) {
    // If the cloud is unreachable, don't hard-lock the POS; treat as active but surface message.
    return {
      status: 'ACTIVE',
      billingEnabled: true,
      message: String(e?.message || 'Could not check billing status'),
    };
  }
});

ipcMain.handle('billing:getStatusLive', async (_e) => {
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud) {
    return { status: 'ACTIVE', billingEnabled: false };
  }
  try {
    return await cloudJson('GET', '/billing/status?live=1', undefined, {
      requireAuth: true,
      senderId: _e.sender.id,
    });
  } catch (e: any) {
    return {
      status: 'ACTIVE',
      billingEnabled: true,
      message: String(e?.message || 'Could not check billing status'),
    };
  }
});

ipcMain.handle('billing:createCheckoutSession', async (_e) => {
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud)
    return { error: 'Cloud billing is not configured on this device' };
  try {
    return await cloudJson(
      'POST',
      '/admin/billing/create-checkout',
      {},
      { requireAuth: true, senderId: _e.sender.id },
    );
  } catch (e: any) {
    return { error: String(e?.message || 'Could not create checkout session') };
  }
});

ipcMain.handle('billing:createPortalSession', async (_e) => {
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud)
    return { error: 'Cloud billing is not configured on this device' };
  try {
    return await cloudJson(
      'POST',
      '/admin/billing/create-portal',
      {},
      { requireAuth: true, senderId: _e.sender.id },
    );
  } catch (e: any) {
    return { error: String(e?.message || 'Could not create portal session') };
  }
});

// Print ticket over ESC/POS
ipcMain.handle('tickets:print', async (_e, input) => {
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  const items = (input?.items as any[]) || [];
  const recordOnly = Boolean((input as any)?.recordOnly);
  const meta = ((input as any)?.meta as any) || null;
  if (!area || !tableLabel || items.length === 0) return false;

  // Local-first: print directly via local PrintJob
  const payload = {
    area,
    tableLabel,
    covers: input?.covers ?? null,
    items,
    note: input?.note ?? null,
    userName: input?.userName || undefined,
    meta: (input as any)?.meta ?? undefined,
  } as any;

  // If this is a payment receipt and includes a discount, add an admin-visible notification entry.
  // (Admin UI lists all notifications, grouped by userName, so we store it against the waiter userId.)
  try {
    const kind = String(meta?.kind || '');
    const userId = Number(meta?.userId || 0);
    const discountAmt = Number(meta?.discountAmount || 0);
    if (
      kind === 'PAYMENT' &&
      userId &&
      Number.isFinite(discountAmt) &&
      discountAmt > 0
    ) {
      const before = Number(meta?.totalBefore ?? meta?.total ?? 0);
      const after = Number(
        meta?.totalAfter ?? Math.max(0, before - discountAmt),
      );
      const dtype = String(meta?.discountType || '').toUpperCase();
      const dval = meta?.discountValue;
      const dLabel =
        dtype === 'PERCENT' && Number.isFinite(Number(dval))
          ? `${Number(dval)}%`
          : dtype === 'AMOUNT' && Number.isFinite(Number(dval))
            ? `${Number(dval).toFixed(2)}`
            : 'custom';
      const reason = String(meta?.discountReason || '').trim();
      const approvedBy = String(meta?.managerApprovedByName || '').trim();
      const msg =
        `Discount applied (${dLabel}) on ${area} Table ${tableLabel}: -${discountAmt.toFixed(2)} ` +
        `(total ${before.toFixed(2)} → ${after.toFixed(2)})` +
        `${meta?.method ? ` · method ${String(meta.method)}` : ''}` +
        `${reason ? ` · reason: ${reason}` : ''}` +
        `${approvedBy ? ` · approved by: ${approvedBy}` : ' · NO MANAGER APPROVAL'}`;
      // Notify actor + all admins
      await prisma.notification.create({
        data: { userId, type: 'OTHER' as any, message: msg } as any,
      });
      const admins = await prisma.user
        .findMany({
          where: { role: 'ADMIN', active: true },
          select: { id: true },
        } as any)
        .catch(() => []);
      for (const a of admins as any[]) {
        await prisma.notification
          .create({
            data: {
              userId: Number(a.id),
              type: 'OTHER' as any,
              message: msg,
            } as any,
          })
          .catch(() => {});
      }
    }
  } catch {
    // do not block printing/logging
  }
  // recordOnly = store receipt snapshot for history without printing.
  if (recordOnly) {
    try {
      await prisma.printJob.create({
        data: {
          type: 'RECEIPT' as any,
          payloadJson: payload,
          status: 'SENT' as any,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  const settings = await readSettings();
  const normalizeProfiles = (s: any) => {
    const arr = Array.isArray(s?.printers) ? s.printers : [];
    if (arr.length) return arr;
    const legacy = s?.printer;
    if (legacy && Object.keys(legacy).length)
      return [
        {
          id: 'default',
          name: 'Default printer',
          enabled: true,
          ...(legacy || {}),
        },
      ];
    return [];
  };
  const pickProfile = (s: any, printerId?: string | null) => {
    const profiles = normalizeProfiles(s).filter(
      (p: any) => p && p.enabled !== false,
    );
    if (!profiles.length) return null;
    if (printerId) {
      const hit = profiles.find((p: any) => String(p.id) === String(printerId));
      if (hit) return hit;
    }
    return profiles[0] || null;
  };
  const printWithProfile = async (printerProfile: any, pld: any) => {
    const mode = (printerProfile?.mode ||
      (printerProfile?.serialPath
        ? 'SERIAL'
        : printerProfile?.deviceName
          ? 'SYSTEM'
          : 'NETWORK')) as any;
    if (mode === 'SYSTEM') {
      const raw = printerProfile?.systemRawEscpos !== false;
      if (raw) {
        const data = buildEscposTicket(pld, settings as any);
        return await sendToCupsRawPrinter({
          deviceName: printerProfile?.deviceName,
          data,
        });
      } else {
        const html = buildHtmlReceipt(pld, settings as any);
        return await printHtmlToSystemPrinter({
          html,
          deviceName: printerProfile?.deviceName,
          silent: printerProfile?.silent !== false,
        });
      }
    }
    if (mode === 'SERIAL') {
      const cfg = {
        path: String(printerProfile?.serialPath || ''),
        baudRate: Number(printerProfile?.baudRate || 19200),
        dataBits: (Number(printerProfile?.dataBits || 8) === 7 ? 7 : 8) as
          | 7
          | 8,
        stopBits: (Number(printerProfile?.stopBits || 1) === 2 ? 2 : 1) as
          | 1
          | 2,
        parity: String(printerProfile?.parity || 'none') as any as
          | 'none'
          | 'even'
          | 'odd',
      };
      if (!cfg.path) return { ok: false, error: 'Serial port not configured' };
      const data = buildEscposTicket(pld, settings as any);
      const { sendToSerialPrinter } = await import('./serial');
      return await sendToSerialPrinter(cfg as any, data);
    }
    const ip = process.env.PRINTER_IP || printerProfile?.ip;
    const port = Number(
      process.env.PRINTER_PORT || printerProfile?.port || 9100,
    );
    if (!ip) return { ok: false, error: 'Printer IP not configured' };
    const data = buildEscposTicket(pld, settings as any);
    const r = await sendToPrinterVerbose(ip, port, data);
    return r.ok
      ? { ok: true }
      : { ok: false, error: r.error || `Send failed (to ${ip}:${port})` };
  };

  const routingEnabled = Boolean((settings as any)?.printerRouting?.enabled);
  const receiptPrinterId =
    (settings as any)?.printerRouting?.receiptPrinterId || 'default';
  const receiptProfile =
    pickProfile(settings, receiptPrinterId) || pickProfile(settings, 'default');
  if (!receiptProfile) return false;

  const kind = String((payload as any)?.meta?.kind || '').toUpperCase();
  let ok = false;
  let firstErr: string | null = null;
  let failCount = 0;
  if (routingEnabled && kind === 'ORDER') {
    const routing = (settings as any)?.printerRouting || {};
    const stationRouting = (routing?.station || {}) as any; // backward compat for fallback
    const categoryRouting = (routing?.categories || {}) as Record<string, string>;
    const fallbackPrinterId = String((routing as any)?.fallbackPrinterId || stationRouting?.ALL || '').trim();
    const normKey = (s: any) =>
      String(s ?? '')
        .trim()
        .toLowerCase();
    const skus = Array.from(
      new Set(items.map((it) => String(it?.sku || '')).filter(Boolean)),
    );
    const menu = skus.length
      ? await prisma.menuItem
          .findMany({
            where: { sku: { in: skus } },
            select: { sku: true, station: true, categoryId: true },
          } as any)
          .catch(() => [])
      : [];
    const bySku = new Map<string, { station?: string; categoryId?: number }>();
    for (const m of menu as any[])
      bySku.set(String(m.sku), {
        station: String(m.station || ''),
        categoryId: Number(m.categoryId),
      });

    const buckets = new Map<string, any[]>();
    for (const it of items) {
      const sku = String(it?.sku || '');
      const info = sku ? bySku.get(sku) : undefined;
      const categoryId = Number.isFinite(Number((it as any)?.categoryId))
        ? Number((it as any).categoryId)
        : info?.categoryId;
      const categoryKey =
        categoryId != null && Number.isFinite(categoryId)
          ? String(categoryId)
          : '';
      const categoryNameKey = normKey((it as any)?.categoryName);
      const printerIdByCategoryName =
        categoryNameKey && categoryRouting[categoryNameKey]
          ? categoryRouting[categoryNameKey]
          : '';
      const printerIdByCategoryId =
        categoryKey && categoryRouting[categoryKey]
          ? categoryRouting[categoryKey]
          : '';
      const printerIdByCategory =
        printerIdByCategoryName || printerIdByCategoryId;
      const printerId = String(printerIdByCategory || fallbackPrinterId || '').trim();
      const groupKey = printerIdByCategory
        ? `CAT:${categoryNameKey || categoryKey || 'unknown'}`
        : `FB:ALL`;
      const key = `${printerId || ''}|${groupKey}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ ...(it as any), station: 'ALL', categoryId });
    }

    let okAll = true;
    for (const [key, groupItems] of buckets.entries()) {
      const [printerId, group] = key.split('|');
      const prof = pickProfile(settings, printerId) || receiptProfile;
      const routeLabel = String(group || '').startsWith('CAT:')
        ? String(group).slice(4)
        : 'all';
      const pld = {
        ...payload,
        items: groupItems,
        meta: {
          ...((payload as any)?.meta || {}),
          kind: 'ORDER',
          station: 'ALL',
          hidePrices: true,
          routeLabel,
        },
      };
      const r = await printWithProfile(prof, pld);
      if (!r.ok) {
        okAll = false;
        failCount++;
        if (!firstErr) firstErr = String((r as any)?.error || 'Print failed');
      }
    }
    ok = okAll;
  } else {
    const r = await printWithProfile(receiptProfile, payload);
    ok = r.ok;
    if (!ok) {
      failCount = 1;
      firstErr = String((r as any)?.error || 'Print failed');
    }
  }

  if (!ok) {
    const c = classifyPrinterError(firstErr);
    broadcastPrinterEvent({
      level: 'error',
      kind: c.kind,
      message: c.userMessage,
      detail: firstErr,
      at: Date.now(),
      context: { area, tableLabel, kind, failures: failCount },
    });
    // Persist as an in-app notification (works for Electron + browser clients)
    try {
      const uid = Number((payload as any)?.meta?.userId || 0);
      if (uid) {
        const msg =
          failCount > 1
            ? `${c.userMessage} (${failCount} print jobs failed)`
            : c.userMessage;
        await prisma.notification.create({
          data: { userId: uid, type: 'OTHER' as any, message: msg } as any,
        });
      }
    } catch {
      // ignore
    }
  }
  // Also store a PrintJob record (useful for receipt history)
  try {
    await prisma.printJob.create({
      data: {
        type: 'RECEIPT' as any,
        payloadJson: payload,
        status: ok ? ('SENT' as any) : ('FAILED' as any),
      },
    });
  } catch {
    // ignore
  }
  return ok;
});

// Waiter-facing ticket lists (receipt-style) - Local-first: always use local DB
ipcMain.handle('reports:listMyActiveTickets', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  if (!userId) return [];
  const listLocal = async () => {
    const [openRow, atRow] = await Promise.all([
      prisma.syncState
        .findUnique({ where: { key: 'tables:open' } })
        .catch(() => null),
      prisma.syncState
        .findUnique({ where: { key: 'tables:openAt' } })
        .catch(() => null),
    ]);
    const openMap = ((openRow?.valueJson as any) || {}) as Record<
      string,
      boolean
    >;
    const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
    const openKeys = Object.entries(openMap)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k);

    const tickets = await Promise.all(
      openKeys.map(async (k) => {
        const [area, tableLabel] = k.split(':');
        if (!area || !tableLabel) return null;
        const last = await prisma.ticketLog
          .findFirst({
            where: { area, tableLabel },
            orderBy: { createdAt: 'desc' },
          })
          .catch(() => null);
        if (!last || Number(last.userId) !== Number(userId)) return null;
        const sinceIso = atMap[k];
        const sinceParsed = sinceIso ? new Date(sinceIso) : null;
        const since =
          sinceParsed && Number.isFinite(sinceParsed.getTime())
            ? sinceParsed
            : null;
        const where: any = { area, tableLabel };
        if (since) where.createdAt = { gte: since };
        const [rows, coversRow, u] = await Promise.all([
          prisma.ticketLog
            .findMany({ where, orderBy: { createdAt: 'asc' } })
            .catch(() => [] as any[]),
          prisma.covers
            .findFirst({
              where: {
                area,
                label: tableLabel,
                ...(since ? { createdAt: { gte: since } as any } : {}),
              },
              orderBy: { id: 'desc' },
            } as any)
            .catch(() => null),
          prisma.user
            .findUnique({ where: { id: last.userId } })
            .catch(() => null),
        ]);
        const itemsAll = rows.flatMap((r: any) =>
          Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [],
        );
        const items = itemsAll.filter((it: any) => !it?.voided);
        const subtotal = items.reduce(
          (s: number, it: any) =>
            s + Number(it.unitPrice || 0) * Number(it.qty || 1),
          0,
        );
        // ACTIVE tickets are not "paid", so we don't have a meta.vatEnabled; use item vatRates.
        const vat = items.reduce(
          (s: number, it: any) =>
            s +
            Number(it.unitPrice || 0) *
              Number(it.qty || 1) *
              Number(it.vatRate || 0),
          0,
        );
        return {
          kind: 'ACTIVE',
          area,
          tableLabel,
          createdAt: since ? since.toISOString() : last.createdAt.toISOString(),
          paidAt: null,
          covers: coversRow?.covers ?? last.covers ?? null,
          note: rows.find((r: any) => r.note)?.note ?? last.note ?? null,
          userName: u?.displayName ?? null,
          paymentMethod: null,
          vatEnabled: null,
          items,
          subtotal,
          vat,
          total: subtotal + vat,
        } as any;
      }),
    );

    return (tickets.filter(Boolean) as any[]).sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
  };

  return await listLocal();
});

ipcMain.handle('reports:listMyPaidTickets', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  const q = String(input?.q || '')
    .trim()
    .toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(input?.limit || 40)));
  if (!userId) return [];

  const listLocal = async () => {
    const jobs = await prisma.printJob
      .findMany({
        where: { type: 'RECEIPT' as any },
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
      .catch(() => []);

    const out: any[] = [];
    for (const j of jobs as any[]) {
      const p = (j.payloadJson as any) || {};
      const meta = (p?.meta as any) || {};
      if (String(meta?.kind || '') !== 'PAYMENT') continue;
      if (Number(meta?.userId || 0) !== Number(userId)) continue;
      const area = String(p.area || '');
      const tableLabel = String(p.tableLabel || '');
      const items = Array.isArray(p.items) ? p.items : [];
      const note = p.note ?? null;
      const covers = (p.covers ?? null) as any;
      const userName = p.userName ?? null;
      const paymentMethod = (meta.method ?? null) as any;
      const paidAt = meta.paidAt ?? j.createdAt.toISOString();
      const subtotal = items.reduce(
        (s: number, it: any) =>
          s + Number(it.unitPrice || 0) * Number(it.qty || 1),
        0,
      );
      const vatEnabled = meta?.vatEnabled !== false;
      const vat = vatEnabled
        ? items.reduce(
            (s: number, it: any) =>
              s +
              Number(it.unitPrice || 0) *
                Number(it.qty || 1) *
                Number(it.vatRate || 0),
            0,
          )
        : 0;
      const serviceChargeEnabled = (meta.serviceChargeEnabled ?? null) as any;
      const serviceChargeApplied = (meta.serviceChargeApplied ?? null) as any;
      const serviceChargeMode = (meta.serviceChargeMode ?? null) as any;
      const serviceChargeValue = (meta.serviceChargeValue ?? null) as any;
      const serviceChargeAmount = Number(meta.serviceChargeAmount || 0);
      const discountType = (meta.discountType ?? null) as any;
      const discountValue = (meta.discountValue ?? null) as any;
      const discountAmount = Number(meta.discountAmount || 0);
      const discountReason = (meta.discountReason ?? null) as any;
      const fallbackTotal = Math.max(
        0,
        subtotal +
          vat +
          (Number.isFinite(serviceChargeAmount) ? serviceChargeAmount : 0) -
          (Number.isFinite(discountAmount) ? discountAmount : 0),
      );
      const totalAfter = Number(meta.totalAfter);
      const total = Number.isFinite(totalAfter)
        ? Math.max(0, totalAfter)
        : fallbackTotal;
      const hay =
        `${area} ${tableLabel} ${String(userName || '')} ${items.map((it: any) => it.name).join(' ')}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      out.push({
        kind: 'PAID',
        area,
        tableLabel,
        createdAt: j.createdAt.toISOString(),
        paidAt,
        covers,
        note,
        userName,
        paymentMethod,
        vatEnabled,
        serviceChargeEnabled,
        serviceChargeApplied,
        serviceChargeMode,
        serviceChargeValue,
        serviceChargeAmount: Number.isFinite(serviceChargeAmount)
          ? serviceChargeAmount
          : null,
        discountType,
        discountValue,
        discountAmount: Number.isFinite(discountAmount) ? discountAmount : null,
        discountReason,
        items,
        subtotal,
        vat,
        total,
      });
      if (out.length >= limit) break;
    }
    return out;
  };

  return await listLocal();
});

// Voided tickets/items report - Local-first
ipcMain.handle('reports:listMyVoidedTickets', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  const limit = Math.min(200, Math.max(1, Number(input?.limit || 40)));
  if (!userId) return [];

  const listLocal = async () => {
    // Find ticket logs that contain voided items or are fully voided (note contains VOIDED)
    const rows = await prisma.ticketLog
      .findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
      .catch(() => []);

    const out: any[] = [];
    for (const r of rows as any[]) {
      const itemsAll = Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [];
      const voidedItems = itemsAll.filter((it: any) => it?.voided === true);
      if (voidedItems.length === 0) continue;

      const note = String(r.note || '');
      const isFullVoid = itemsAll.every((it: any) => it?.voided === true);
      const u = await prisma.user
        .findUnique({ where: { id: r.userId } })
        .catch(() => null);

      const subtotal = voidedItems.reduce(
        (s: number, it: any) =>
          s + Number(it.unitPrice || 0) * Number(it.qty || 1),
        0,
      );
      const vat = voidedItems.reduce(
        (s: number, it: any) =>
          s +
          Number(it.unitPrice || 0) *
            Number(it.qty || 1) *
            Number(it.vatRate || 0),
        0,
      );

      out.push({
        kind: isFullVoid ? 'VOIDED_TICKET' : 'VOIDED_ITEMS',
        area: r.area,
        tableLabel: r.tableLabel,
        createdAt: r.createdAt.toISOString(),
        note,
        userName: u?.displayName ?? null,
        covers: r.covers ?? null,
        items: voidedItems,
        totalItems: itemsAll.length,
        voidedCount: voidedItems.length,
        subtotal,
        vat,
        total: subtotal,
      });
      if (out.length >= limit) break;
    }
    return out;
  };

  return await listLocal();
});

// Persist open tables in SyncState - Local-first: always use local DB
ipcMain.handle('tables:setOpen', async (_e, input) => {
  const area = String(input?.area || '');
  const label = String(input?.label || '');
  const open = Boolean(input?.open);
  if (!area || !label) return false;

  await coreServices.setTableOpen(area, label, open);
  // Track open timestamp for current session
  const keyAt = 'tables:openAt';
  const atRow = await prisma.syncState.findUnique({ where: { key: keyAt } });
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const kKey = `${area}:${label}`;
  // IMPORTANT: do NOT reset openAt on repeated "open=true" calls.
  if (open) {
    if (!atMap[kKey]) atMap[kKey] = new Date().toISOString();
  } else {
    delete atMap[kKey];
  }
  await prisma.syncState.upsert({
    where: { key: keyAt },
    create: { key: keyAt, valueJson: atMap },
    update: { valueJson: atMap },
  });

  // If a table is being closed, also close the active KDS order (if any).
  if (!open) {
    try {
      const active = await (prisma as any).kdsOrder.findFirst({
        where: { area, tableLabel: label, closedAt: null },
        orderBy: { openedAt: 'desc' },
      });
      if (active) {
        await (prisma as any).kdsOrder.update({
          where: { id: active.id },
          data: { closedAt: new Date() },
        });
      }
    } catch {
      // ignore if KDS tables are not migrated yet
    }
  }
  return true;
});

// Local-first: always use local SyncState for open tables
ipcMain.handle('tables:listOpen', async (_e) => {
  const key = 'tables:open';
  const row = await prisma.syncState.findUnique({ where: { key } });
  const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
  return Object.entries(map)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => {
      const [area, label] = k.split(':');
      return { area, label };
    });
});

// Local-first: always use local transfer
ipcMain.handle('tables:transfer', async (_e, payload) => {
  try {
    const input = TransferTableInputSchema.parse(payload);
    return await transferTableLocal(input as any);
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Transfer failed') };
  }
});

// Menu syncing from remote URL removed: business admins manage menu directly.

// Local-first: always use local DB for menu
ipcMain.handle('menu:listCategoriesWithItems', async (_e) => {
  const cats = await prisma.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    // Include inactive items too so admins can re-enable, and waiters can see disabled items greyed out.
    include: { items: { orderBy: { name: 'asc' } } },
  });
  return cats.map((c: any) => ({
    id: c.id,
    name: c.name,
    sortOrder: c.sortOrder,
    active: c.active,
    color: (c as any)?.color ?? null,
    items: c.items.map((i: any) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      price: Number(i.price),
      vatRate: Number(i.vatRate),
      active: i.active,
      categoryId: i.categoryId,
      isKg: Boolean((i as any)?.isKg),
      station: String((i as any)?.station || 'KITCHEN'),
    })),
  }));
});

ipcMain.handle('menu:createCategory', async (_e, payload) => {
  const input = CreateMenuCategoryInputSchema.parse(payload);
  const created = await prisma.category.create({
    data: {
      name: input.name.trim(),
      sortOrder: Number(input.sortOrder ?? 0),
      active: input.active ?? true,
      color: (input as any).color ?? null,
    } as any,
  });
  return { id: created.id };
});

ipcMain.handle('menu:updateCategory', async (_e, payload) => {
  const input = UpdateMenuCategoryInputSchema.parse(payload);
  await prisma.category.update({
    where: { id: input.id },
    data: {
      ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
      ...(typeof input.sortOrder === 'number'
        ? { sortOrder: input.sortOrder }
        : {}),
      ...((input as any).color !== undefined
        ? { color: (input as any).color }
        : {}),
      ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
    } as any,
  });
  return true;
});

ipcMain.handle('menu:deleteCategory', async (_e, payload) => {
  const id = Number((payload as any)?.id || 0);
  if (!id) return false;
  await prisma.category
    .update({ where: { id }, data: { active: false } as any })
    .catch(() => null);
  await prisma.menuItem
    .updateMany({ where: { categoryId: id }, data: { active: false } as any })
    .catch(() => null);
  return true;
});

ipcMain.handle('menu:createItem', async (_e, payload) => {
  const input = CreateMenuItemInputSchema.parse(payload);
  const created = await prisma.menuItem.create({
    data: {
      name: input.name.trim(),
      sku: String(input.sku || input.name).trim(),
      categoryId: Number(input.categoryId),
      price: Number(input.price),
      vatRate: Number(
        (input as any).vatRate ?? process.env.VAT_RATE_DEFAULT ?? 0.2,
      ),
      active: (input as any).active ?? true,
      isKg: (input as any).isKg ?? false,
      ...(typeof (input as any).station === 'string'
        ? { station: String((input as any).station).toUpperCase() }
        : {}),
    } as any,
  });
  return { id: created.id, sku: created.sku };
});

ipcMain.handle('menu:updateItem', async (_e, payload) => {
  const input = UpdateMenuItemInputSchema.parse(payload);
  await prisma.menuItem.update({
    where: { id: input.id },
    data: {
      ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
      ...(typeof input.price === 'number' ? { price: input.price } : {}),
      ...(typeof (input as any).vatRate === 'number'
        ? { vatRate: (input as any).vatRate }
        : {}),
      ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
      ...(typeof (input as any).isKg === 'boolean'
        ? { isKg: (input as any).isKg }
        : {}),
      ...(typeof input.categoryId === 'number'
        ? { categoryId: input.categoryId }
        : {}),
      ...(typeof (input as any).station === 'string'
        ? { station: String((input as any).station).toUpperCase() }
        : {}),
    } as any,
  });
  return true;
});

ipcMain.handle('menu:deleteItem', async (_e, payload) => {
  const id = Number((payload as any)?.id || 0);
  if (!id) return false;
  await prisma.menuItem
    .update({ where: { id }, data: { active: false } as any })
    .catch(() => null);
  return true;
});

// Admin overview - Local-first: always use local DB
ipcMain.handle('admin:getOverview', async (_e) => {
  const [
    users,
    openShifts,
    openTables,
    lowStock,
    queued,
    menuSync,
    staffSync,
    revenueRows,
  ] = await Promise.all([
    prisma.user.count({ where: { active: true } }),
    prisma.dayShift.count({ where: { closedAt: null } }),
    (async () => {
      const key = 'tables:open';
      const row = await prisma.syncState
        .findUnique({ where: { key } })
        .catch(() => null);
      const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
      return Object.values(map).filter(Boolean).length;
    })(),
    prisma.inventoryItem
      .count({
        where: {
          qtyOnHand: { lt: prisma.inventoryItem.fields.lowStockThreshold },
        },
      })
      .catch(() => 0),
    prisma.printJob.count({ where: { status: 'QUEUED' } }).catch(() => 0),
    prisma.syncState
      .findUnique({ where: { key: 'menu:lastSync' } })
      .catch(() => null),
    prisma.syncState
      .findUnique({ where: { key: 'staff:lastSync' } })
      .catch(() => null),
    prisma.ticketLog
      .findMany({
        where: {
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lte: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        },
        select: { itemsJson: true },
      })
      .catch(() => []),
  ]);
  const revenueTodayNet = (revenueRows as any[]).reduce(
    (s, r) =>
      s +
      (r.itemsJson as any[]).reduce(
        (ss: number, it: any) =>
          ss + Number(it.unitPrice) * Number(it.qty || 1),
        0,
      ),
    0,
  );
  const revenueTodayVat = (revenueRows as any[]).reduce(
    (s, r) =>
      s +
      (r.itemsJson as any[]).reduce(
        (ss: number, it: any) =>
          ss +
          Number(it.unitPrice) * Number(it.qty || 1) * Number(it.vatRate || 0),
        0,
      ),
    0,
  );
  return {
    activeUsers: users,
    openShifts,
    openOrders: openTables,
    lowStockItems: lowStock || 0,
    queuedPrintJobs: queued || 0,
    lastMenuSync: (menuSync as any)?.updatedAt?.toISOString?.() ?? null,
    lastStaffSync: (staffSync as any)?.updatedAt?.toISOString?.() ?? null,
    printerIp: process.env.PRINTER_IP ?? null,
    appVersion: process.env.npm_package_version || '0.1.0',
    revenueTodayNet,
    revenueTodayVat,
  };
});

ipcMain.handle('admin:openWindow', async () => {
  createAdminWindow();
  return true;
});

ipcMain.handle('kds:openWindow', async () => {
  createKdsWindow();
  return true;
});

// Backups: create/list/restore (local SQLite)
ipcMain.handle('backups:list', async () => {
  return listDbBackups();
});

ipcMain.handle('backups:create', async () => {
  return await createDbBackupNow();
});

ipcMain.handle('backups:restore', async (_e, input) => {
  const name = String((input as any)?.name || '');
  return await restoreDbBackup(name);
});

ipcMain.handle('backups:uploadToCloud', async (_e, input) => {
  const name = String((input as any)?.name || '').trim();
  const cloud = await getCloudConfig().catch(() => null);
  if (!cloud) return { ok: false, error: 'Cloud not configured' };
  const pw = await getCloudAccessPassword().catch(() => null);
  if (!pw) return { ok: false, error: 'Cloud access password not set' };
  const dir = getBackupsDir();
  const safeName = name ? String(name).replace(/[^0-9A-Za-z._-]/g, '') : '';
  const filePath = safeName ? join(dir, safeName.endsWith('.db') ? safeName : `${safeName}.db`) : null;
  let toUpload = filePath && fs.existsSync(filePath) ? filePath : null;
  if (!toUpload) {
    const created = await createDbBackupNow();
    if (!created.ok || !created.file) return { ok: false, error: created.error || 'Backup failed' };
    toUpload = created.file;
  }
  try {
    const fileBuffer = fs.readFileSync(toUpload);
    const filename = basename(toUpload);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), filename);
    const url = `${cloud.backendUrl.replace(/\/+$/, '')}/backups/upload`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-business-code': cloud.businessCode,
        'x-business-password': pw,
      } as any,
      body: formData as any,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      return { ok: false, error: String(err?.error || res.statusText) };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Upload failed') };
  }
});

ipcMain.handle('sync:fromCloud', async (_e) => {
  return syncFromCloudManual();
});

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function getEnabledStations() {
  try {
    const s: any = await readSettings();
    const raw = (s as any)?.kds?.enabledStations;
    const arr = Array.isArray(raw)
      ? raw.map((x) => String(x).toUpperCase())
      : ['KITCHEN'];
    const uniq = Array.from(new Set(arr.filter(Boolean)));
    return uniq.length ? uniq : ['KITCHEN'];
  } catch {
    return ['KITCHEN'];
  }
}

async function createKdsTicketFromLog(input: {
  userId: number;
  area: string;
  tableLabel: string;
  items: any[];
  note?: string | null;
}) {
  const okSchema = await ensureKdsLocalSchema();
  if (!okSchema) return null;
  const enabled = new Set(await getEnabledStations());
  const stations = Array.from(enabled);
  const fallbackStation = stations[0] || 'KITCHEN';

  const lines = Array.isArray(input.items) ? input.items : [];
  const skus = Array.from(
    new Set(
      lines
        .map((it) => String(it?.sku || '').trim())
        .filter((s) => s.length > 0),
    ),
  );

  // Resolve station per SKU (default KITCHEN).
  let skuToStation: Record<string, string> = {};
  try {
    if (skus.length) {
      const menuRows = await (prisma as any).menuItem.findMany({
        where: { sku: { in: skus } },
        select: { sku: true, station: true },
      });
      for (const r of menuRows as any[]) {
        const st = String((r as any)?.station || 'KITCHEN').toUpperCase();
        skuToStation[String((r as any)?.sku || '')] = enabled.has(st)
          ? st
          : fallbackStation;
      }
    }
  } catch {
    // ignore
  }

  const decorated = lines.map((it: any) => {
    // 1. Use the station already attached to the item (set by the renderer from menu data)
    const itemStation = String(it?.station || '').toUpperCase();
    if (itemStation && enabled.has(itemStation)) {
      return { ...it, station: itemStation };
    }
    // 2. Fall back to local DB lookup by SKU
    const sku = String(it?.sku || '').trim();
    const stRaw = sku ? skuToStation[sku] : '';
    if (stRaw && enabled.has(String(stRaw).toUpperCase())) {
      return { ...it, station: String(stRaw).toUpperCase() };
    }
    // 3. If the item has a known station that's NOT enabled (e.g. BAR item but only KITCHEN is enabled),
    //    keep its real station so it gets filtered out of the KDS view rather than mis-routed to KITCHEN.
    if (itemStation) {
      return { ...it, station: itemStation };
    }
    // 4. No station info at all — default to KITCHEN
    return { ...it, station: fallbackStation };
  });

  const usedStations = Array.from(
    new Set(
      decorated
        .map((it: any) => String(it?.station || '').toUpperCase())
        .filter((s) => enabled.has(s)),
    ),
  );
  if (usedStations.length === 0) return null;

  // Find current open KDS order for this table; if none, create with next orderNo for the day.
  const now = new Date();
  const dayKey = dayKeyLocal(now);

  const created = await (prisma as any).$transaction(async (tx: any) => {
    // In cloud mode, `input.userId` can be a cloud user id that doesn't exist in the local SQLite `User` table.
    // Our self-healing schema may add a FK on KdsTicket.userId, so only set it if the local user exists.
    let safeUserId: number | null = null;
    try {
      const u = await tx.user.findUnique({
        where: { id: Number(input.userId) },
      });
      safeUserId = u ? Number(input.userId) : null;
    } catch {
      safeUserId = null;
    }

    let order = await tx.kdsOrder.findFirst({
      where: { area: input.area, tableLabel: input.tableLabel, closedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    if (!order) {
      const counter = await tx.kdsDayCounter.upsert({
        where: { dayKey },
        create: { dayKey, lastNo: 0 },
        update: {},
      });
      const nextNo = Number(counter?.lastNo || 0) + 1;
      await tx.kdsDayCounter.update({
        where: { dayKey },
        data: { lastNo: nextNo },
      });
      order = await tx.kdsOrder.create({
        data: {
          dayKey,
          orderNo: nextNo,
          area: input.area,
          tableLabel: input.tableLabel,
          openedAt: now,
        },
      });
    }

    const ticket = await tx.kdsTicket.create({
      data: {
        orderId: order.id,
        userId: safeUserId,
        firedAt: now,
        itemsJson: decorated,
        note: input.note ?? null,
      },
    });

    for (const st of usedStations) {
      await tx.kdsTicketStation.create({
        data: {
          ticketId: ticket.id,
          station: st,
          status: 'NEW',
        },
      });
    }

    return { orderNo: order.orderNo, ticketId: ticket.id };
  });

  return created;
}

async function applyKdsVoidTicket(input: {
  userId: number;
  area: string;
  tableLabel: string;
  reason?: string;
}) {
  const okSchema = await ensureKdsLocalSchema();
  if (!okSchema) return false;
  const area = String(input.area || '');
  const tableLabel = String(input.tableLabel || '');
  if (!area || !tableLabel) return false;

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      const order = await tx.kdsOrder.findFirst({
        where: { area, tableLabel, closedAt: null },
        orderBy: { openedAt: 'desc' },
      });
      if (!order) return;

      // Only set bumpedById if the user exists locally (cloud user ids may not).
      let safeBumpedById: number | null = null;
      try {
        const u = await tx.user.findUnique({
          where: { id: Number(input.userId) },
        });
        safeBumpedById = u ? Number(input.userId) : null;
      } catch {
        safeBumpedById = null;
      }

      const tickets = await tx.kdsTicket.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'asc' },
      });
      const now = new Date();
      for (const t of tickets) {
        const items = (Array.isArray(t.itemsJson) ? t.itemsJson : []).map(
          (it: any) => ({ ...it, voided: true }),
        );
        const note = t.note
          ? `${t.note} | VOIDED${input.reason ? `: ${input.reason}` : ''}`
          : `VOIDED${input.reason ? `: ${input.reason}` : ''}`;
        await tx.kdsTicket.update({
          where: { id: t.id },
          data: { itemsJson: items, note },
        });
        // Mark all stations NEW->DONE so they disappear from the kitchen queue
        await tx.kdsTicketStation.updateMany({
          where: { ticketId: t.id, status: 'NEW' },
          data: {
            status: 'DONE',
            bumpedAt: now,
            ...(safeBumpedById ? { bumpedById: safeBumpedById } : {}),
          },
        });
      }
      await tx.kdsOrder.update({
        where: { id: order.id },
        data: { closedAt: now },
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function applyKdsVoidItem(input: {
  userId: number;
  area: string;
  tableLabel: string;
  item: any;
}) {
  const okSchema = await ensureKdsLocalSchema();
  if (!okSchema) return false;
  const area = String(input.area || '');
  const tableLabel = String(input.tableLabel || '');
  const name = String(input?.item?.name || '').trim();
  const sku = String(input?.item?.sku || '').trim();
  if (!area || !tableLabel || !name) return false;

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      const order = await tx.kdsOrder.findFirst({
        where: { area, tableLabel, closedAt: null },
        orderBy: { openedAt: 'desc' },
      });
      if (!order) return;

      // Only set bumpedById if the user exists locally (cloud user ids may not).
      let safeBumpedById: number | null = null;
      try {
        const u = await tx.user.findUnique({
          where: { id: Number(input.userId) },
        });
        safeBumpedById = u ? Number(input.userId) : null;
      } catch {
        safeBumpedById = null;
      }

      const tickets = await tx.kdsTicket.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'asc' },
      });
      const now = new Date();
      for (const t of tickets) {
        const itemsAll = Array.isArray(t.itemsJson)
          ? (t.itemsJson as any[])
          : [];
        let changed = false;
        const nextItems = itemsAll.map((it: any) => {
          const itSku = String(it?.sku || '').trim();
          const itName = String(it?.name || '').trim();
          const match = (sku && itSku && itSku === sku) || itName === name;
          if (match && !it?.voided) {
            changed = true;
            return { ...it, voided: true };
          }
          return it;
        });
        if (changed) {
          await tx.kdsTicket.update({
            where: { id: t.id },
            data: { itemsJson: nextItems },
          });

          // For each station on this ticket: if no remaining non-voided items, mark station DONE.
          const stations = await tx.kdsTicketStation.findMany({
            where: { ticketId: t.id },
          });
          for (const stRow of stations) {
            const station = String(stRow.station || '').toUpperCase();
            const remaining = nextItems.filter(
              (it: any) =>
                !it?.voided &&
                String(it?.station || '').toUpperCase() === station,
            );
            if (remaining.length === 0) {
              await tx.kdsTicketStation.updateMany({
                where: { ticketId: t.id, station, status: 'NEW' },
                data: {
                  status: 'DONE',
                  bumpedAt: now,
                  ...(safeBumpedById ? { bumpedById: safeBumpedById } : {}),
                },
              });
            }
          }
        }
      }
    });
    return true;
  } catch {
    return false;
  }
}

// Tickets logging
ipcMain.handle('tickets:log', async (_e, payload) => {
  try {
    // Rate limit ticket creation
    if (
      !checkRateLimit(_e, 'tickets:log', {
        maxAttempts: 100,
        windowMs: 60 * 1000,
      })
    ) {
      throw new Error('Too many requests. Please slow down.');
    }

    const { userId, area, tableLabel, covers, items, note } = payload || {};
    if (!userId || !area || !tableLabel) return false;

    // Sanitize inputs
    const sanitizedArea = sanitizeString(area, 50);
    const sanitizedTableLabel = sanitizeString(tableLabel, 50);
    const sanitizedNote = note ? sanitizeString(note, 500) : null;
    const sanitizedCovers = covers ? sanitizeNumber(covers, 1, 999, 0) : null;

    // Validate items array
    if (!Array.isArray(items) || items.length === 0) return false;

    // Local-first: always use local DB for tickets
    await prisma.ticketLog.create({
      data: {
        userId: Number(userId),
        area: sanitizedArea,
        tableLabel: sanitizedTableLabel,
        covers: sanitizedCovers,
        itemsJson: items ?? [],
        note: sanitizedNote,
      },
    });

    // KDS: create station-specific ticket rows (best-effort; does not block sending).
    try {
      await createKdsTicketFromLog({
        userId: Number(userId),
        area: sanitizedArea,
        tableLabel: sanitizedTableLabel,
        items: items ?? [],
        note: sanitizedNote,
      });
    } catch (e: any) {
      __kdsLastError = String(e?.message || e || 'Failed to create KDS ticket');
      console.error('KDS create ticket failed', e);
      captureException(e instanceof Error ? e : new Error(String(e)), {
        context: 'tickets:log:KDS',
      });
    }
    return true;
  } catch (error: any) {
    captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        context: 'tickets:log',
        payload: {
          userId: payload?.userId,
          area: payload?.area,
          tableLabel: payload?.tableLabel,
        },
      },
    );
    throw error; // Re-throw to maintain existing error handling behavior
  }
});

ipcMain.handle('tickets:getLatestForTable', async (_e, input) => {
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  if (!area || !tableLabel) return null;
  const last = await prisma.ticketLog.findFirst({
    where: { area, tableLabel },
    orderBy: { createdAt: 'desc' },
  });
  if (!last) return null;
  const items = Array.isArray(last.itemsJson) ? (last.itemsJson as any[]) : [];
  return {
    items: items.filter((it: any) => !it?.voided) as any,
    note: last.note ?? null,
    covers: last.covers ?? null,
    createdAt: last.createdAt.toISOString(),
    userId: last.userId,
  };
});

// Tooltip stats for a table: covers, first ticket time, latest total
ipcMain.handle('tickets:getTableTooltip', async (_e, input) => {
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  if (!area || !tableLabel) return null;
  // Show only for currently open tables
  const openRow = await prisma.syncState.findUnique({
    where: { key: 'tables:open' },
  });
  const openMap = ((openRow?.valueJson as any) || {}) as Record<
    string,
    boolean
  >;
  const k = `${area}:${tableLabel}`;
  if (!openMap[k]) return null;
  // Session start time
  const atRow = await prisma.syncState.findUnique({
    where: { key: 'tables:openAt' },
  });
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const sinceIso = atMap[k];
  const sinceParsed = sinceIso ? new Date(sinceIso) : null;
  const since =
    sinceParsed && Number.isFinite(sinceParsed.getTime()) ? sinceParsed : null;
  const where: any = { area, tableLabel };
  if (since) where.createdAt = { gte: since };
  const [last, coversRow] = await Promise.all([
    prisma.ticketLog.findFirst({ where, orderBy: { createdAt: 'desc' } }),
    prisma.covers.findFirst({
      where: {
        area,
        label: tableLabel,
        ...(since ? { createdAt: { gte: since } as any } : {}),
      },
      orderBy: { id: 'desc' },
    } as any),
  ]);
  const items = ((last?.itemsJson as any[]) || []).filter(
    (it: any) => !it.voided,
  );
  const total = items.reduce(
    (s: number, it: any) => s + Number(it.unitPrice || 0) * Number(it.qty || 1),
    0,
  );
  return {
    covers: coversRow?.covers ?? null,
    firstAt: since
      ? since.toISOString()
      : last
        ? new Date(last.createdAt).toISOString()
        : null,
    total,
  };
});

// KDS: list tickets by station + status (NEW/DONE)
ipcMain.handle('kds:listTickets', async (_e, input) => {
  const station = String((input as any)?.station || 'KITCHEN').toUpperCase();
  const status = String((input as any)?.status || 'NEW').toUpperCase();
  const limit = Math.min(
    200,
    Math.max(1, Number((input as any)?.limit || 100)),
  );
  // IMPORTANT: KDS is always local (even when POS is in cloud mode).

  await ensureKdsLocalSchema();
  try {
    const rows = await (prisma as any).kdsTicketStation.findMany({
      where: { station, status },
      include: { ticket: { include: { order: true } } },
      orderBy:
        status === 'NEW'
          ? { ticket: { firedAt: 'asc' } }
          : { bumpedAt: 'desc' },
      take: limit,
    });

    return (rows as any[])
      .map((r: any) => {
        const t = r.ticket;
        const o = t?.order;
        const itemsAll = Array.isArray(t?.itemsJson) ? t.itemsJson : [];
        const items = itemsAll
          .map((it: any, idx: number) => ({ ...it, _idx: idx }))
          .filter(
            (it: any) =>
              String(it?.station || '').toUpperCase() === station &&
              !it?.voided,
          )
          .filter((it: any) => (status === 'NEW' ? !it?.bumped : true));
        // In NEW view, hide station cards that have no remaining items (e.g., everything was voided).
        if (status === 'NEW' && items.length === 0) return null;
        return {
          ticketId: t?.id,
          orderNo: o?.orderNo,
          area: o?.area,
          tableLabel: o?.tableLabel,
          firedAt: t?.firedAt?.toISOString?.() ?? null,
          note: t?.note ?? null,
          items,
          bumpedAt: r?.bumpedAt?.toISOString?.() ?? null,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
});

ipcMain.handle('kds:debug', async () => {
  const cloud = await getCloudConfig().catch(() => null);
  const schemaReady = await ensureKdsLocalSchema();
  const enabledStations = await getEnabledStations();
  const out: any = {
    mode: cloud ? 'cloud+local-kds' : 'local',
    schemaReady,
    enabledStations,
    lastError: __kdsLastError,
    counts: {},
    latest: null,
  };
  out.counts.ticketLog = await prisma.ticketLog.count().catch(() => 0);
  if (schemaReady) {
    out.counts.kdsOrders = await (prisma as any).kdsOrder
      .count()
      .catch(() => 0);
    out.counts.kdsTickets = await (prisma as any).kdsTicket
      .count()
      .catch(() => 0);
    out.counts.kdsStations = await (prisma as any).kdsTicketStation
      .count()
      .catch(() => 0);
    out.latest = await (prisma as any).kdsTicketStation
      .findFirst({
        orderBy: { id: 'desc' },
        include: { ticket: { include: { order: true } } },
      })
      .catch(() => null);
  }
  return out;
});

ipcMain.handle('kds:bump', async (_e, input) => {
  const station = String((input as any)?.station || 'KITCHEN').toUpperCase();
  const ticketId = Number((input as any)?.ticketId || 0);
  const bumpedById = Number((input as any)?.userId || 0) || null;
  if (!ticketId) return false;
  // IMPORTANT: KDS is always local (even when POS is in cloud mode).

  await ensureKdsLocalSchema();
  try {
    const updated = await (prisma as any).kdsTicketStation.updateMany({
      where: { ticketId, station, status: 'NEW' },
      data: {
        status: 'DONE',
        bumpedAt: new Date(),
        ...(bumpedById ? { bumpedById } : {}),
      },
    });
    return Boolean(updated?.count);
  } catch {
    return false;
  }
});

ipcMain.handle('kds:bumpItem', async (_e, input) => {
  const station = String((input as any)?.station || 'KITCHEN').toUpperCase();
  const ticketId = Number((input as any)?.ticketId || 0);
  const itemIdx = Number((input as any)?.itemIdx ?? -1);
  const bumpedById = Number((input as any)?.userId || 0) || null;
  if (!ticketId || !Number.isFinite(itemIdx) || itemIdx < 0) return false;
  await ensureKdsLocalSchema();
  const now = new Date();
  try {
    const ticket = await (prisma as any).kdsTicket
      .findUnique({ where: { id: ticketId } })
      .catch(() => null);
    if (!ticket) return false;
    const itemsAll: any[] = Array.isArray(ticket.itemsJson)
      ? ticket.itemsJson
      : [];
    if (itemIdx >= itemsAll.length) return false;
    const it = itemsAll[itemIdx];
    if (!it) return false;
    if (String(it?.station || '').toUpperCase() !== station) return false;
    if (it?.voided) return true;
    if (it?.bumped) return true;
    const nextItems = itemsAll.slice();
    nextItems[itemIdx] = { ...it, bumped: true, bumpedAt: now.toISOString() };
    await (prisma as any).kdsTicket.update({
      where: { id: ticketId },
      data: { itemsJson: nextItems },
    });

    // If no remaining items for this station, auto-complete the station ticket.
    const remaining = nextItems.filter(
      (x: any) =>
        !x?.voided &&
        !x?.bumped &&
        String(x?.station || '').toUpperCase() === station,
    );
    if (remaining.length === 0) {
      await (prisma as any).kdsTicketStation.updateMany({
        where: { ticketId, station, status: 'NEW' },
        data: {
          status: 'DONE',
          bumpedAt: now,
          ...(bumpedById ? { bumpedById } : {}),
        },
      });
    }
    return true;
  } catch {
    return false;
  }
});

// Void item: records a notification and returns true
ipcMain.handle('tickets:voidItem', async (_e, input) => {
  const userId = Number(input?.userId);
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  const item = input?.item as any;
  const approvedByAdminId =
    input?.approvedByAdminId != null ? Number(input.approvedByAdminId) : null;
  const approvedByAdminName =
    input?.approvedByAdminName != null ? String(input.approvedByAdminName) : '';
  if (!userId || !area || !tableLabel || !item?.name) return false;

  // Enforce admin PIN approval for voids if enabled in settings.
  // In cloud mode, pass actorRole from the renderer since cloud user IDs may not exist locally.
  const actorRoleHint = String(input?.actorRole || '').trim();
  try {
    const settings: any = await readSettings();
    const requireApproval =
      settings?.security?.approvals?.requireManagerPinForVoid !== false;
    if (requireApproval) {
      const actor = await prisma.user
        .findUnique({ where: { id: userId } })
        .catch(() => null);
      const actorIsAdmin =
        (actor && String((actor as any)?.role || '').toUpperCase() === 'ADMIN') ||
        (!actor && actorRoleHint.toUpperCase() === 'ADMIN');
      if (!actorIsAdmin) {
        if (!approvedByAdminId) return false;
        const approver = await prisma.user
          .findUnique({ where: { id: approvedByAdminId } })
          .catch(() => null);
        const approverIsAdmin =
          approver &&
          (approver as any).active !== false &&
          String((approver as any).role || '').toUpperCase() === 'ADMIN';
        if (!approverIsAdmin) return false;
      }
    }
  } catch {
    // Fail closed when approvals are on by default.
    return false;
  }
  const message = `Voided item on ${area} ${tableLabel}: ${item.name} x${Number(item.qty || 1)}${approvedByAdminId ? ` (approved by: ${approvedByAdminName || `admin#${approvedByAdminId}`})` : ''}`;
  // Notify actor + all admins (anti-theft audit trail)
  await prisma.notification
    .create({ data: { userId, type: 'OTHER' as any, message } })
    .catch(() => {});
  try {
    const admins = await prisma.user
      .findMany({
        where: { role: 'ADMIN', active: true },
        select: { id: true },
      } as any)
      .catch(() => []);
    for (const a of admins as any[]) {
      await prisma.notification
        .create({
          data: { userId: Number(a.id), type: 'OTHER' as any, message },
        })
        .catch(() => {});
    }
  } catch {
    // ignore
  }
  // Also append a void marker in the latest ticket log for this table (if exists)
  const last = await prisma.ticketLog.findFirst({
    where: { area, tableLabel },
    orderBy: { createdAt: 'desc' },
  });
  if (last) {
    const items = (last.itemsJson as any[]) || [];
    const idx = items.findIndex((it: any) => it.name === item.name);
    if (idx !== -1) {
      items[idx] = { ...items[idx], voided: true };
      await prisma.ticketLog.update({
        where: { id: last.id },
        data: { itemsJson: items },
      });
    }
  }
  await applyKdsVoidItem({ userId, area, tableLabel, item }).catch(() => false);
  return true;
});

ipcMain.handle('tickets:voidTicket', async (_e, input) => {
  const userId = Number(input?.userId);
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  const reason = String(input?.reason || '');
  const approvedByAdminId =
    input?.approvedByAdminId != null ? Number(input.approvedByAdminId) : null;
  const approvedByAdminName =
    input?.approvedByAdminName != null ? String(input.approvedByAdminName) : '';
  if (!userId || !area || !tableLabel) return false;

  // Enforce admin PIN approval for voids if enabled in settings.
  const actorRoleHint = String(input?.actorRole || '').trim();
  try {
    const settings: any = await readSettings();
    const requireApproval =
      settings?.security?.approvals?.requireManagerPinForVoid !== false;
    if (requireApproval) {
      const actor = await prisma.user
        .findUnique({ where: { id: userId } })
        .catch(() => null);
      const actorIsAdmin =
        (actor && String((actor as any)?.role || '').toUpperCase() === 'ADMIN') ||
        (!actor && actorRoleHint.toUpperCase() === 'ADMIN');
      if (!actorIsAdmin) {
        if (!approvedByAdminId) return false;
        const approver = await prisma.user
          .findUnique({ where: { id: approvedByAdminId } })
          .catch(() => null);
        const approverIsAdmin =
          approver &&
          (approver as any).active !== false &&
          String((approver as any).role || '').toUpperCase() === 'ADMIN';
        if (!approverIsAdmin) return false;
      }
    }
  } catch {
    return false;
  }
  // Local-first: close table locally
  try {
    await coreServices.setTableOpen(area, tableLabel, false);
  } catch {
    // ignore
  }
  const message = `Voided ticket on ${area} ${tableLabel}${reason ? `: ${reason}` : ''}${approvedByAdminId ? ` (approved by: ${approvedByAdminName || `admin#${approvedByAdminId}`})` : ''}`;
  // Notify actor + all admins (anti-theft audit trail)
  await prisma.notification
    .create({ data: { userId, type: 'OTHER' as any, message } })
    .catch(() => {});
  try {
    const admins = await prisma.user
      .findMany({
        where: { role: 'ADMIN', active: true },
        select: { id: true },
      } as any)
      .catch(() => []);
    for (const a of admins as any[]) {
      await prisma.notification
        .create({
          data: { userId: Number(a.id), type: 'OTHER' as any, message },
        })
        .catch(() => {});
    }
  } catch {
    // ignore
  }
  // Mark all items in the latest ticket as voided for admin view
  const last = await prisma.ticketLog.findFirst({
    where: { area, tableLabel },
    orderBy: { createdAt: 'desc' },
  });
  if (last) {
    const items = ((last.itemsJson as any[]) || []).map((it: any) => ({
      ...it,
      voided: true,
    }));
    await prisma.ticketLog.update({
      where: { id: last.id },
      data: {
        itemsJson: items,
        note: last.note
          ? `${last.note} | VOIDED${reason ? `: ${reason}` : ''}`
          : `VOIDED${reason ? `: ${reason}` : ''}`,
      },
    });
  }
  // Close table in local open map + openAt so it becomes FREE immediately
  try {
    await coreServices.setTableOpen(area, tableLabel, false);
    const keyAt = 'tables:openAt';
    const atRow = await prisma.syncState.findUnique({ where: { key: keyAt } });
    const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
    delete atMap[`${area}:${tableLabel}`];
    await prisma.syncState.upsert({
      where: { key: keyAt },
      create: { key: keyAt, valueJson: atMap },
      update: { valueJson: atMap },
    });
  } catch {
    // ignore
  }
  // Also close active KDS order (best-effort)
  try {
    const active = await (prisma as any).kdsOrder.findFirst({
      where: { area, tableLabel, closedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    if (active)
      await (prisma as any).kdsOrder.update({
        where: { id: active.id },
        data: { closedAt: new Date() },
      });
  } catch {
    // ignore
  }
  await applyKdsVoidTicket({ userId, area, tableLabel, reason }).catch(
    () => false,
  );
  return true;
});

ipcMain.handle('admin:listTicketsByUser', async (_e, input) => {
  const userId = Number(input?.userId);
  if (!userId) return [];
  const where: any = { userId };
  if (input?.startIso || input?.endIso) {
    where.createdAt = {};
    if (input?.startIso) where.createdAt.gte = new Date(input.startIso);
    if (input?.endIso) where.createdAt.lte = new Date(input.endIso);
  }
  const rows = await prisma.ticketLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r: any) => ({
    id: r.id,
    area: r.area,
    tableLabel: r.tableLabel,
    covers: r.covers,
    createdAt: r.createdAt.toISOString(),
    items: r.itemsJson as any,
    note: r.note,
    subtotal: (r.itemsJson as any[]).reduce(
      (s: number, it: any) => s + Number(it.unitPrice) * Number(it.qty || 1),
      0,
    ),
    vat: (r.itemsJson as any[]).reduce(
      (s: number, it: any) =>
        s +
        Number(it.unitPrice) * Number(it.qty || 1) * Number(it.vatRate || 0),
      0,
    ),
  }));
});

// Notifications IPC
ipcMain.handle('notifications:list', async (_e, input) => {
  const onlyUnread = Boolean(input?.onlyUnread);
  const userId = Number(input?.userId);
  if (!userId) return [];
  const rows = await prisma.notification.findMany({
    where: { userId, ...(onlyUnread ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
  } as any);
  return rows.map((n: any) => ({
    id: n.id,
    type: n.type,
    message: n.message,
    readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
    createdAt: new Date(n.createdAt).toISOString(),
  }));
});

ipcMain.handle('notifications:markAllRead', async (_e, input) => {
  const userId = Number(input?.userId);
  if (!userId) return false;
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return true;
});

ipcMain.handle('admin:listTicketCounts', async (_e, input) => {
  const where: any = {};
  if (input?.startIso || input?.endIso) {
    where.createdAt = {};
    if (input?.startIso) where.createdAt.gte = new Date(input.startIso);
    if (input?.endIso) where.createdAt.lte = new Date(input.endIso);
  }
  const logs = await prisma.ticketLog
    .groupBy({ where, by: ['userId'], _count: { userId: true } } as any)
    .catch(() => []);
  const users = await prisma.user.findMany({
    where: { role: { not: 'ADMIN' } } as any,
  });
  const openShifts = await prisma.dayShift.findMany({
    where: { closedAt: null },
  });
  const openIds = new Set(openShifts.map((s: any) => s.openedById));
  const counts: Record<number, number> = {};
  for (const r of logs as any[]) counts[r.userId] = r._count.userId;
  return users.map((u: any) => ({
    id: u.id,
    name: u.displayName,
    active: openIds.has(u.id),
    tickets: counts[u.id] ?? 0,
  }));
});

ipcMain.handle('admin:listShifts', async (_e, input) => {
  const where: any = {};
  if (input?.startIso || input?.endIso) {
    where.openedAt = {};
    if (input?.startIso) where.openedAt.gte = new Date(input.startIso);
    if (input?.endIso) where.openedAt.lte = new Date(input.endIso);
  }
  const rows = await prisma.dayShift
    .findMany({
      where,
      orderBy: { openedAt: 'desc' },
      include: { openedBy: true, closedBy: true },
    } as any)
    .catch(() => []);
  return rows.map((r: any) => {
    const end = r.closedAt ? new Date(r.closedAt) : new Date();
    const start = new Date(r.openedAt);
    const durationMs = Math.max(0, end.getTime() - start.getTime());
    const durationHours = Math.round((durationMs / 36e5) * 100) / 100;
    return {
      id: r.id,
      userId: r.openedById,
      userName: r.openedBy?.displayName ?? `#${r.openedById}`,
      openedAt: r.openedAt.toISOString(),
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
      durationHours,
      isOpen: !r.closedAt,
    };
  });
});

ipcMain.handle('admin:listNotifications', async (_e, input) => {
  const onlyUnread = Boolean(input?.onlyUnread);
  const limit = Number(input?.limit || 100);
  const rows = await prisma.notification.findMany({
    where: { ...(onlyUnread ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { user: true },
  } as any);
  return rows.map((n: any) => ({
    id: n.id,
    userId: n.userId,
    userName: n.user?.displayName ?? `#${n.userId}`,
    type: n.type,
    message: n.message,
    readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
    createdAt: new Date(n.createdAt).toISOString(),
  }));
});

ipcMain.handle('admin:markAllNotificationsRead', async (_e) => {
  await prisma.notification.updateMany({
    where: { readAt: null },
    data: { readAt: new Date() },
  });
  return true;
});

// Top selling item today from TicketLog
ipcMain.handle('admin:getTopSellingToday', async (_e) => {
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date(new Date().setHours(23, 59, 59, 999));
  const rows = await prisma.ticketLog.findMany({
    where: { createdAt: { gte: start, lte: end } },
    select: { itemsJson: true },
  });
  const map = new Map<string, { qty: number; revenue: number }>();
  for (const r of rows) {
    const items = (r.itemsJson as any[]) || [];
    for (const it of items) {
      const name = String(it.name || 'Item');
      const qty = Number(it.qty || 1);
      const revenue = Number(it.unitPrice || 0) * qty;
      const entry = map.get(name) || { qty: 0, revenue: 0 };
      entry.qty += qty;
      entry.revenue += revenue;
      map.set(name, entry);
    }
  }
  let best: { name: string; qty: number; revenue: number } | null = null;
  for (const [name, v] of map.entries()) {
    if (!best || v.qty > best.qty)
      best = { name, qty: v.qty, revenue: v.revenue };
  }
  return best;
});

// Sales trends (daily/weekly/monthly)
ipcMain.handle('admin:getSalesTrends', async (_e, input) => {
  const range = (input?.range as any) || 'daily';
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  let start: Date;
  let buckets: { key: string; label: string; from: Date; to: Date }[] = [];
  if (range === 'daily') {
    // last 14 days
    start = new Date(today.getTime() - 13 * 86400000);
    for (let i = 0; i < 14; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const from = new Date(d.setHours(0, 0, 0, 0));
      const to = new Date(d.setHours(23, 59, 59, 999));
      const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`;
      const key = `${from.getFullYear()}-${from.getMonth() + 1}-${from.getDate()}`;
      buckets.push({ key, label, from, to });
    }
  } else if (range === 'weekly') {
    // last 12 weeks
    start = new Date(today.getTime() - 7 * 86400000 * 11);
    for (let i = 0; i < 12; i++) {
      const from = new Date(start.getTime() + i * 7 * 86400000);
      const to = new Date(from.getTime() + 6 * 86400000);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      const oneJan = new Date(from.getFullYear(), 0, 1);
      const week = Math.ceil(
        ((from.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) /
          7,
      );
      const label = `${from.getFullYear()}-W${String(week).padStart(2, '0')}`;
      const key = label;
      buckets.push({ key, label, from, to });
    }
  } else {
    // monthly, last 12 months
    const startYear = today.getFullYear();
    let m = today.getMonth() - 11;
    for (let i = 0; i < 12; i++, m++) {
      const year = startYear + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12;
      const from = new Date(year, month, 1, 0, 0, 0, 0);
      const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
      const label = `${year}-${String(month + 1).padStart(2, '0')}`;
      const key = label;
      buckets.push({ key, label, from, to });
    }
  }

  const rows = await prisma.ticketLog.findMany({
    where: {
      createdAt: { gte: buckets[0].from, lte: buckets[buckets.length - 1].to },
    },
    select: { createdAt: true, itemsJson: true },
    orderBy: { createdAt: 'asc' },
  });
  const result = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
  for (const r of rows) {
    const when = new Date(r.createdAt);
    const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
    if (idx === -1) continue;
    const net = (r.itemsJson as any[]).reduce(
      (s: number, it: any) => s + Number(it.unitPrice) * Number(it.qty || 1),
      0,
    );
    result[idx].total += net;
    result[idx].orders += 1;
  }
  return { range, points: result } as any;
});

// Waiter-facing reports (per-user)
// Security log (admin only)
ipcMain.handle('admin:getSecurityLog', async (_e, input) => {
  const limit = sanitizeNumber(input?.limit, 1, 1000, 100);
  return getSecurityLog(limit);
});

// Memory monitoring (admin only)
ipcMain.handle('admin:getMemoryStats', async () => {
  const stats = getMemoryStats();
  const currentUsage = getMemoryUsage();
  return {
    current: stats.current,
    average: stats.average,
    peak: stats.peak,
    trend: stats.trend,
    formatted: formatMemoryUsage(currentUsage),
  };
});

ipcMain.handle('admin:exportMemorySnapshot', async () => {
  return await exportMemorySnapshot();
});

ipcMain.handle('reports:getMyOverview', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  if (!userId) return { revenueTodayNet: 0, revenueTodayVat: 0, openOrders: 0 };
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date();
  const rows = await prisma.ticketLog
    .findMany({
      where: { userId, createdAt: { gte: start, lte: end } },
      select: { itemsJson: true },
    })
    .catch(() => []);
  const revenueTodayNet = rows.reduce(
    (s: number, r: any) =>
      s +
      ((r.itemsJson as any[]) || []).reduce(
        (ss: number, it: any) =>
          ss + Number(it.unitPrice || 0) * Number(it.qty || 1),
        0,
      ),
    0,
  );
  const revenueTodayVat = rows.reduce(
    (s: number, r: any) =>
      s +
      ((r.itemsJson as any[]) || []).reduce(
        (ss: number, it: any) =>
          ss +
          Number(it.unitPrice || 0) *
            Number(it.qty || 1) *
            Number(it.vatRate || 0),
        0,
      ),
    0,
  );
  // Open orders: open tables where latest ticket owner is this user.
  const openList = await prisma.syncState
    .findUnique({ where: { key: 'tables:open' } })
    .catch(() => null);
  const map = ((openList?.valueJson as any) || {}) as Record<string, boolean>;
  const openKeys = Object.entries(map)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
  const latests = await Promise.all(
    openKeys.map(async (k: string) => {
      const [area, label] = k.split(':');
      if (!area || !label) return false;
      const last = await prisma.ticketLog
        .findFirst({
          where: { area, tableLabel: label },
          orderBy: { createdAt: 'desc' },
        })
        .catch(() => null);
      return Boolean(last && Number(last.userId) === Number(userId));
    }),
  );
  const openOrders = latests.filter(Boolean).length;
  return { revenueTodayNet, revenueTodayVat, openOrders };
});

ipcMain.handle('reports:getMyTopSellingToday', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  if (!userId) return null;
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date(new Date().setHours(23, 59, 59, 999));
  const rows = await prisma.ticketLog.findMany({
    where: { userId, createdAt: { gte: start, lte: end } },
    select: { itemsJson: true },
  });
  const map = new Map<string, { qty: number; revenue: number }>();
  for (const r of rows) {
    const items = (r.itemsJson as any[]) || [];
    for (const it of items) {
      const name = String(it.name || 'Item');
      const qty = Number(it.qty || 1);
      const revenue = Number(it.unitPrice || 0) * qty;
      const entry = map.get(name) || { qty: 0, revenue: 0 };
      entry.qty += qty;
      entry.revenue += revenue;
      map.set(name, entry);
    }
  }
  let best: { name: string; qty: number; revenue: number } | null = null;
  for (const [name, v] of map.entries()) {
    if (!best || v.qty > best.qty)
      best = { name, qty: v.qty, revenue: v.revenue };
  }
  return best;
});

ipcMain.handle('reports:getMySalesTrends', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  const range = (input?.range as any) || 'daily';
  if (!userId) return { range, points: [] } as any;
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  let buckets: { label: string; from: Date; to: Date }[] = [];
  if (range === 'daily') {
    const start = new Date(today.getTime() - 13 * 86400000);
    for (let i = 0; i < 14; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const from = new Date(d.setHours(0, 0, 0, 0));
      const to = new Date(d.setHours(23, 59, 59, 999));
      const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`;
      buckets.push({ label, from, to });
    }
  } else if (range === 'weekly') {
    const start = new Date(today.getTime() - 7 * 86400000 * 11);
    for (let i = 0; i < 12; i++) {
      const from = new Date(start.getTime() + i * 7 * 86400000);
      const to = new Date(from.getTime() + 6 * 86400000);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      const oneJan = new Date(from.getFullYear(), 0, 1);
      const week = Math.ceil(
        ((from.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) /
          7,
      );
      const label = `${from.getFullYear()}-W${String(week).padStart(2, '0')}`;
      buckets.push({ label, from, to });
    }
  } else {
    const startYear = today.getFullYear();
    let m = today.getMonth() - 11;
    for (let i = 0; i < 12; i++, m++) {
      const year = startYear + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12;
      const from = new Date(year, month, 1, 0, 0, 0, 0);
      const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
      const label = `${year}-${String(month + 1).padStart(2, '0')}`;
      buckets.push({ label, from, to });
    }
  }
  const rows = await prisma.ticketLog
    .findMany({
      where: {
        userId,
        createdAt: {
          gte: buckets[0].from,
          lte: buckets[buckets.length - 1].to,
        },
      },
      select: { createdAt: true, itemsJson: true },
      orderBy: { createdAt: 'asc' },
    })
    .catch(() => []);
  const result = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
  for (const r of rows as any[]) {
    const when = new Date(r.createdAt);
    const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
    if (idx === -1) continue;
    const net = ((r.itemsJson as any[]) || []).reduce(
      (s: number, it: any) => s + Number(it.unitPrice) * Number(it.qty || 1),
      0,
    );
    result[idx].total += net;
    result[idx].orders += 1;
  }
  return { range, points: result } as any;
});
// Covers API
ipcMain.handle('covers:save', async (_e, { area, label, covers }) => {
  const num = Number(covers);
  if (!area || !label || !Number.isFinite(num) || num <= 0) return false;
  await prisma.covers.create({ data: { area, label, covers: num } });
  return true;
});

ipcMain.handle('covers:getLast', async (_e, { area, label }) => {
  const row = await prisma.covers.findFirst({
    where: { area, label },
    orderBy: { id: 'desc' },
  });
  return row?.covers ?? null;
});

// Layout persistence (per user, per area) via SyncState
ipcMain.handle('layout:get', async (_e, { userId, area }) => {
  const key = `layout:${userId}:${area}`;
  const row = await prisma.syncState.findUnique({ where: { key } });
  return (row?.valueJson as any)?.nodes ?? null;
});

ipcMain.handle('layout:save', async (_e, { userId, area, nodes }) => {
  const key = `layout:${userId}:${area}`;
  await prisma.syncState.upsert({
    where: { key },
    create: { key, valueJson: { nodes } },
    update: { valueJson: { nodes } },
  });
  return true;
});

// Create a request from non-owner
ipcMain.handle('requests:create', async (_e, input) => {
  const { requesterId, ownerId, area, tableLabel, items, note } = input || {};
  if (!requesterId || !ownerId || !area || !tableLabel || !Array.isArray(items))
    return false;

  const created = await prisma.ticketRequest.create({
    data: {
      requesterId: Number(requesterId),
      ownerId: Number(ownerId),
      area: String(area),
      tableLabel: String(tableLabel),
      itemsJson: items,
      note: note ? String(note) : null,
      status: 'PENDING' as any,
    },
  });

  // Notify owner
  const requester = await prisma.user.findUnique({
    where: { id: Number(requesterId) },
  });
  const msg = `${requester?.displayName || 'Staff'} requested to add items on ${area} ${tableLabel} (Request #${created.id})`;
  await prisma.notification
    .create({
      data: { userId: Number(ownerId), type: 'OTHER' as any, message: msg },
    })
    .catch(() => {});
  return true;
});

// List pending requests for owner
ipcMain.handle('requests:listForOwner', async (_e, input) => {
  const ownerId = Number(input?.ownerId);
  if (!ownerId) return [];
  const rows = await prisma.ticketRequest.findMany({
    where: { ownerId, status: 'PENDING' as any },
    orderBy: { createdAt: 'desc' },
  } as any);
  return rows.map((r: any) => ({
    id: r.id,
    area: r.area,
    tableLabel: r.tableLabel,
    requesterId: r.requesterId,
    items: r.itemsJson,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
});

// Approve or reject
ipcMain.handle('requests:approve', async (_e, input) => {
  const id = Number(input?.id);
  const ownerId = Number(input?.ownerId);
  if (!id || !ownerId) return false;
  const r = await prisma.ticketRequest.findUnique({ where: { id } });
  if (!r || r.ownerId !== ownerId || r.status !== ('PENDING' as any))
    return false;
  await prisma.ticketRequest.update({
    where: { id },
    data: { status: 'APPROVED' as any, decidedAt: new Date() },
  });
  // Persist the approval by appending items to the latest ticket log snapshot
  try {
    const last = await prisma.ticketLog.findFirst({
      where: { area: r.area, tableLabel: r.tableLabel },
      orderBy: { createdAt: 'desc' },
    });
    const baseItems = ((last?.itemsJson as any[]) || []).map((it: any) => ({
      name: String(it.name || 'Item'),
      qty: Number(it.qty || 1),
      unitPrice: Number(it.unitPrice || 0),
      vatRate: Number(it.vatRate || 0),
      note: it.note ?? null,
    }));
    const incoming = ((r.itemsJson as any[]) || []).map((it: any) => ({
      name: String(it.name || 'Item'),
      qty: Number(it.qty || 1),
      unitPrice: Number(it.unitPrice || 0),
      vatRate: Number(it.vatRate || 0),
      note: it.note ?? null,
    }));
    const map = new Map<string, any>();
    for (const it of baseItems) {
      map.set(it.name, { ...it });
    }
    for (const it of incoming) {
      const existing = map.get(it.name);
      if (existing) {
        map.set(it.name, {
          ...existing,
          qty: Number(existing.qty || 0) + Number(it.qty || 1),
        });
      } else {
        map.set(it.name, { ...it });
      }
    }
    const merged = Array.from(map.values());
    await prisma.ticketLog.create({
      data: {
        userId: r.ownerId,
        area: r.area,
        tableLabel: r.tableLabel,
        covers: last?.covers ?? null,
        itemsJson: merged,
        note: last?.note ?? null,
      },
    });
  } catch {
    // ignore
  }
  await prisma.notification
    .create({
      data: {
        userId: r.requesterId,
        type: 'OTHER' as any,
        message: `Your request #${id} on ${r.area} ${r.tableLabel} was approved`,
      },
    })
    .catch(() => {});
  return true;
});

ipcMain.handle('requests:reject', async (_e, input) => {
  const id = Number(input?.id);
  const ownerId = Number(input?.ownerId);
  if (!id || !ownerId) return false;
  const r = await prisma.ticketRequest.findUnique({ where: { id } });
  if (!r || r.ownerId !== ownerId || r.status !== ('PENDING' as any))
    return false;
  await prisma.ticketRequest.update({
    where: { id },
    data: { status: 'REJECTED' as any, decidedAt: new Date() },
  });
  await prisma.notification
    .create({
      data: {
        userId: r.requesterId,
        type: 'OTHER' as any,
        message: `Your request #${id} on ${r.area} ${r.tableLabel} was rejected`,
      },
    })
    .catch(() => {});
  return true;
});

// Owner's OrderPage polls approved requests for current table
ipcMain.handle('requests:pollApprovedForTable', async (_e, input) => {
  const ownerId = Number(input?.ownerId);
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  if (!ownerId || !area || !tableLabel) return [];
  const rows = await prisma.ticketRequest.findMany({
    where: { ownerId, area, tableLabel, status: 'APPROVED' as any },
    orderBy: { createdAt: 'asc' },
  } as any);
  return rows.map((r: any) => ({ id: r.id, items: r.itemsJson, note: r.note }));
});

// Mark applied so we don’t re-apply
ipcMain.handle('requests:markApplied', async (_e, input) => {
  const ids: number[] = Array.isArray(input?.ids) ? input.ids : [];
  if (!ids.length) return false;
  await prisma.ticketRequest.updateMany({
    where: { id: { in: ids }, status: 'APPROVED' as any },
    data: { status: 'APPLIED' as any, decidedAt: new Date() },
  } as any);
  return true;
});
