import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join, dirname, resolve as resolvePath, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import dotenv from 'dotenv';
// Initialize Sentry early (before other imports that might throw)
import {
  initSentry,
  setSentryUser,
  captureException,
  addBreadcrumb,
  sentryEnabled,
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
  isCloudAdmin,
  isCloudAdminForSender,
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

      const cloud = await getCloudConfig().catch(() => null);
      const cloudActorUserId = cloud
        ? getCloudSessionUserId(cloud.businessCode) || null
        : null;
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

        // Cloud: void ticket as the "system actor" (whoever is logged in on the host).
        // This must NOT require manager PIN; it's an automated system cleanup.
        const systemUserId = Number(cloudActorUserId || 0) || 0;
        if (cloud && systemUserId) {
          try {
            await cloudJson(
              'POST',
              '/tickets/void-ticket',
              { userId: systemUserId, area, tableLabel, reason },
              { requireAuth: true, senderId: 0 },
            );
          } catch (e: any) {
            await enqueueOutbox({
              id: `tickets:void-ticket:${area}:${tableLabel}:${Date.now()}`,
              method: 'POST',
              path: '/tickets/void-ticket',
              body: { userId: systemUserId, area, tableLabel, reason },
              requireAuth: true,
              dedupeKey: `tickets:void-ticket:${area}:${tableLabel}`,
            });
          }
        }

        // Also cancel any pending/approved "add items" requests for this stale table.
        if (cloud) {
          try {
            await cloudJson(
              'POST',
              '/requests/cancel-stale-for-table',
              { area, tableLabel, cutoffHours: 12 },
              { requireAuth: true, senderId: 0 },
            );
          } catch {
            await enqueueOutbox({
              id: `requests:cancel-stale:${area}:${tableLabel}:${Date.now()}`,
              method: 'POST',
              path: '/requests/cancel-stale-for-table',
              body: { area, tableLabel, cutoffHours: 12 },
              requireAuth: true,
              dedupeKey: `requests:cancel-stale:${area}:${tableLabel}`,
            });
          }
        } else {
          // Local mode: mark pending/approved requests as rejected and notify.
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

        // In cloud mode, also enqueue table close if needed.
        if (cloud) {
          try {
            await cloudJson(
              'POST',
              '/tables/open',
              { area, label: tableLabel, open: false },
              { requireAuth: true, senderId: 0 },
            );
          } catch (e: any) {
            await enqueueOutbox({
              id: `tables:open:${area}:${tableLabel}:${Date.now()}`,
              method: 'POST',
              path: '/tables/open',
              body: { area, label: tableLabel, open: false },
              requireAuth: true,
              dedupeKey: `tables:open:${area}:${tableLabel}`,
            });
          }
        }

        // Override: if cloud still reports this table as open, hide it from the UI until cloud close succeeds.
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
  createWindow();
  setupAutoUpdater();
  await startApiServer();
  // In cloud mode, also act as an on-prem Printer Station (pull queued print jobs and print locally).
  startPrinterStationLoop();
  // Offline outbox: retry queued cloud writes when connectivity returns.
  startOutboxLoop();
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
  // Rate limit login attempts
  if (
    !checkRateLimit(_e, 'auth:loginWithPin', {
      maxAttempts: 5,
      windowMs: 5 * 60 * 1000,
    })
  ) {
    logSecurityEvent('ipc_rate_limit_exceeded', {
      handler: 'auth:loginWithPin',
      senderId: _e.sender.id,
    });
    throw new Error(
      'Too many login attempts. Please wait before trying again.',
    );
  }

  const { pin, userId } = LoginWithPinInputSchema.parse(payload);

  // Validate PIN format (but don't reject weak PINs during login - users may already have them)
  const pinValidation = validatePin(pin, false); // rejectWeak = false for login
  if (!pinValidation.valid) {
    logSecurityEvent('invalid_pin_format', { senderId: _e.sender.id, userId });
    throw new Error(pinValidation.error || 'Invalid PIN format');
  }
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // Hosted mode (multi-business)
    const resp = await cloudJson<{ user: any; token: string } | null>(
      'POST',
      '/auth/login',
      { businessCode: cloud.businessCode, pin, userId: userId ?? undefined },
      { requireAuth: false },
    ).catch(() => null);
    if (!resp || !resp.user || !resp.token) return null;
    // Store token + role in main process for future admin calls
    try {
      setCloudSession({
        token: String(resp.token),
        businessCode: cloud.businessCode,
        role: String(resp.user?.role || 'WAITER') as any,
        userId: Number(resp.user?.id || 0),
      });
      try {
        setCloudSessionForSender(_e.sender.id, {
          token: String(resp.token),
          businessCode: cloud.businessCode,
          role: String(resp.user?.role || 'WAITER') as any,
          userId: Number(resp.user?.id || 0),
        } as any);
      } catch {
        // ignore per-sender storage errors
      }
    } catch {
      setCloudToken(String(resp.token), cloud.businessCode);
    }
    // Set Sentry user context after successful cloud login
    setSentryUser(
      Number(resp.user?.id || 0),
      resp.user?.displayName,
      resp.user?.role,
    );
    addBreadcrumb('User logged in (cloud)', 'auth', 'info');
    return resp.user;
  }

  const where: any = userId ? { id: userId, active: true } : { active: true };
  const user = await prisma.user.findFirst({ where });
  if (!user) return null;
  const ok = await bcrypt.compare(pin, user.pinHash);
  if (!ok) {
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
    return null;
  }
  const userData = {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
  };
  // Set Sentry user context after successful login
  setSentryUser(user.id, user.displayName, user.role);
  addBreadcrumb('User logged in', 'auth', 'info');
  return userData;
});

ipcMain.handle('auth:verifyManagerPin', async (_e, payload) => {
  const pin = String((payload as any)?.pin || '').trim();
  // Validate format (but don't reject weak PINs during verification - managers may already have them)
  const pinValidation = validatePin(pin, false); // rejectWeak = false for verification
  if (!pinValidation.valid) return { ok: false };
  if (await cloudEnabledButMissingBusinessCode()) return { ok: false };
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    try {
      const r: any = await cloudJson(
        'POST',
        '/auth/verify-manager-pin',
        { businessCode: cloud.businessCode, pin },
        { requireAuth: false, senderId: _e.sender.id },
      );
      return r && typeof r === 'object' ? r : { ok: false };
    } catch {
      return { ok: false };
    }
  }
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
    if (ok)
      return {
        ok: true,
        userId: (u as any).id,
        userName: (u as any).displayName,
      };
  }
  return { ok: false };
});

ipcMain.handle('auth:logoutAdmin', async (_e) => {
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // Clear persisted admin cloud token (and any per-window token for safety)
    clearCloudAdminSession();
    clearCloudSessionForSender(_e.sender.id);
  }
  // Force this window back to login immediately
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
  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    return await cloudJson('POST', '/auth/users', input, {
      requireAuth: true,
      senderId: _e.sender.id,
    });
  }

  // Local (SQLite) guard:
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
  // Cloud-only behavior: if provider backend is configured but businessCode is missing,
  // do NOT fall back to local users (prevents cross-tenant/local leakage).
  const settings = await coreServices.readSettings().catch(() => null as any);
  const cloudBackendUrl = String(settings?.cloud?.backendUrl || '').trim();
  const cloudBusinessCode = String(settings?.cloud?.businessCode || '').trim();
  if (cloudBackendUrl && !cloudBusinessCode) return [];

  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // Login screen needs users before auth → use public endpoint
    const includeAdmins = (payload as any)?.includeAdmins !== false;
    const pw = await getCloudAccessPassword().catch(() => null);
    return await cloudJson(
      'GET',
      `/auth/public-users?businessCode=${encodeURIComponent(cloud.businessCode)}&includeAdmins=${includeAdmins ? '1' : '0'}`,
      undefined,
      {
        requireAuth: false,
        extraHeaders: pw ? { 'x-business-password': pw } : undefined,
      },
    ).catch(() => []);
  }
  const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
  return users.map((u: any) => ({
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

  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    return await cloudJson(
      'PUT',
      `/auth/users/${encodeURIComponent(String(input.id))}`,
      sanitizedInput,
      { requireAuth: true, senderId: _e.sender.id },
    );
  }
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

  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // Hosted mode: we only "disable" via DELETE endpoint
    await cloudJson(
      'DELETE',
      `/auth/users/${encodeURIComponent(String(id))}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    );
    return true;
  }

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

// Shifts IPC
ipcMain.handle('shifts:getOpen', async (_e, { userId }) => {
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // Login screen may call this before auth; return null instead of throwing.
    if (!hasCloudSession(cloud.businessCode)) return null;
    return await cloudJson(
      'GET',
      `/shifts/get-open?userId=${encodeURIComponent(String(userId))}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => null);
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    return await cloudJson(
      'POST',
      '/shifts/clock-in',
      { userId },
      { requireAuth: true, senderId: _e.sender.id },
    );
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    return await cloudJson(
      'POST',
      '/shifts/clock-out',
      { userId },
      { requireAuth: true, senderId: _e.sender.id },
    );
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // Login screen may call this before auth. Use a public endpoint so "clocked in" is accurate on fresh boot.
    if (!hasCloudSession(cloud.businessCode)) {
      const q = new URLSearchParams({ businessCode: cloud.businessCode });
      const pw = await getCloudAccessPassword().catch(() => null);
      return await cloudJson(
        'GET',
        `/shifts/public-open?${q.toString()}`,
        undefined,
        {
          requireAuth: false,
          extraHeaders: pw ? { 'x-business-password': pw } : undefined,
        },
      ).catch(() => []);
    }
    return await cloudJson('GET', '/shifts/open', undefined, {
      requireAuth: true,
      senderId: _e.sender.id,
    }).catch(() => []);
  }
  const open = await prisma.dayShift.findMany({ where: { closedAt: null } });
  return open.map((s: { openedById: number }) => s.openedById);
});

// Sync staff from external API and upsert into local users
ipcMain.handle('auth:syncStaffFromApi', async (_e, raw) => {
  // Deprecated in hosted cloud mode.
  if (await cloudEnabledButMissingBusinessCode()) return 0;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) return 0;
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
      const r = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-business-password': nextPwRaw,
        } as any,
      } as any);
      const data = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(data) || data.length === 0) {
        throw new Error('Invalid Business code or Business password.');
      }
      // Normalize the code back into the input so it is stored consistently.
      (input as any).cloud = { ...((input as any).cloud || {}), businessCode };
    }
  } catch (e: any) {
    throw new Error(String(e?.message || e || 'Invalid cloud settings'));
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
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // Cloud mode: enqueue a PrintJob for the Printer Station (avoid direct printing from clients).
    if (!hasCloudSession(cloud.businessCode)) return false;
    const payload = {
      area,
      tableLabel,
      covers: input?.covers ?? null,
      items,
      note: input?.note ?? null,
      userName: input?.userName || undefined,
      meta: (input as any)?.meta ?? undefined,
    } as any;
    const idem = `print:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    let status: 'SENT' | 'FAILED' | 'QUEUED' = 'SENT';
    try {
      await cloudJson(
        'POST',
        '/print-jobs/enqueue',
        { type: 'RECEIPT', payload, recordOnly, idempotencyKey: idem },
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        status = 'QUEUED';
        await enqueueOutbox({
          id: `print-jobs:enqueue:${idem}`,
          method: 'POST',
          path: '/print-jobs/enqueue',
          body: { type: 'RECEIPT', payload, recordOnly, idempotencyKey: idem },
          requireAuth: true,
        });
      } else {
        status = 'FAILED';
      }
    }
    // Also store a local PrintJob snapshot for history/reports even in cloud mode.
    try {
      await prisma.printJob.create({
        data: {
          type: 'RECEIPT' as any,
          payloadJson: payload,
          status: status as any,
        },
      });
    } catch {
      // ignore
    }
    return status !== 'FAILED';
  }
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
    const stationRouting = (routing?.station || {}) as any;
    const categoryRouting = (routing?.categories || {}) as Record<
      string,
      string
    >;
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
      const station =
        (String(
          (it as any)?.station || info?.station || 'KITCHEN',
        ).toUpperCase() as any) || 'KITCHEN';
      const printerIdByStation =
        stationRouting?.[station] || stationRouting?.ALL || '';
      const printerId = printerIdByCategory || printerIdByStation || '';
      const groupKey = printerIdByCategory
        ? `CAT:${categoryNameKey || categoryKey || 'unknown'}`
        : `ST:${station}`;
      const key = `${printerId || ''}|${groupKey}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ ...(it as any), station, categoryId });
    }

    let okAll = true;
    for (const [key, groupItems] of buckets.entries()) {
      const [printerId, group] = key.split('|');
      const prof = pickProfile(settings, printerId) || receiptProfile;
      const routeLabel = String(group || '').startsWith('CAT:')
        ? String(group).slice(4)
        : String(group || '').startsWith('ST:')
          ? String(group).slice(3)
          : '';
      const st = String(group || '').startsWith('ST:')
        ? String(group).slice(3)
        : 'ALL';
      const pld = {
        ...payload,
        items: groupItems,
        meta: {
          ...((payload as any)?.meta || {}),
          kind: 'ORDER',
          station: st,
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

// Waiter-facing ticket lists (receipt-style)
ipcMain.handle('reports:listMyActiveTickets', async (_e, input) => {
  if (await cloudEnabledButMissingBusinessCode()) return [];
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

  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return [];
    // Cloud server may be older and not have these endpoints yet. Fall back to local computation on 404.
    try {
      return await cloudJson('GET', '/reports/my/active-tickets', undefined, {
        requireAuth: true,
        senderId: _e.sender.id,
      });
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      if (msg.toLowerCase().includes('not found')) return await listLocal();
      throw e;
    }
  }

  return await listLocal();
});

ipcMain.handle('reports:listMyPaidTickets', async (_e, input) => {
  if (await cloudEnabledButMissingBusinessCode()) return [];
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

  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) {
      // Don't silently hide; UI should show the real reason.
      throw new Error('Cloud session missing (please log in again)');
    }
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    qs.set('limit', String(limit));
    try {
      return await cloudJson(
        'GET',
        `/reports/my/paid-tickets?${qs.toString()}`,
        undefined,
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      if (msg.toLowerCase().includes('not found')) return await listLocal();
      throw e;
    }
  }

  return await listLocal();
});

// Persist open tables in SyncState for accurate open order counts
ipcMain.handle('tables:setOpen', async (_e, input) => {
  const area = String(input?.area || '');
  const label = String(input?.label || '');
  const open = Boolean(input?.open);
  if (!area || !label) return false;
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    const kKey = `${area}:${label}`;
    // Always mirror locally (used by local fallbacks like reports when cloud endpoints are missing).
    try {
      await coreServices.setTableOpen(area, label, open);
      const keyAt = 'tables:openAt';
      const atRow = await prisma.syncState.findUnique({
        where: { key: keyAt },
      });
      const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
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
    } catch {
      // ignore
    }
    // Best-effort cloud sync (older servers may not support it). If offline, queue and return optimistic success.
    try {
      return await cloudJson(
        'POST',
        '/tables/open',
        { area, label, open },
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        await enqueueOutbox({
          id: `tables:open:${area}:${label}:${Date.now()}`,
          method: 'POST',
          path: '/tables/open',
          body: { area, label, open },
          requireAuth: true,
          dedupeKey: `tables:open:${area}:${label}`,
        });
        return true;
      }
      return true;
    }
  }
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

ipcMain.handle('tables:listOpen', async (_e) => {
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    const keyClosedOverride = 'tables:closedOverride';
    const closedRow = await prisma.syncState
      .findUnique({ where: { key: keyClosedOverride } })
      .catch(() => null);
    const closedOverride = ((closedRow?.valueJson as any) || {}) as Record<
      string,
      string
    >;
    const now = Date.now();
    // Cleanup old overrides (> 7 days)
    try {
      let changed = false;
      for (const [k, iso] of Object.entries(closedOverride)) {
        const t = iso ? new Date(iso).getTime() : NaN;
        if (!Number.isFinite(t) || now - t > 7 * 24 * 60 * 60 * 1000) {
          delete closedOverride[k];
          changed = true;
        }
      }
      if (changed) {
        await prisma.syncState
          .upsert({
            where: { key: keyClosedOverride },
            create: { key: keyClosedOverride, valueJson: closedOverride },
            update: { valueJson: closedOverride },
          })
          .catch(() => null);
      }
    } catch {
      // ignore
    }

    const isOverridden = (area: string, label: string) =>
      Boolean(closedOverride[`${area}:${label}`]);

    // If cloud session is missing, fall back to local open map (offline-friendly).
    if (!hasCloudSession(cloud.businessCode)) {
      const key = 'tables:open';
      const row = await prisma.syncState.findUnique({ where: { key } });
      const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
      return Object.entries(map)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => {
          const [area, label] = k.split(':');
          return { area, label };
        })
        .filter(
          (t) => !isOverridden(String(t.area || ''), String(t.label || '')),
        );
    }

    const cloudOpen = await cloudJson('GET', '/tables/open', undefined, {
      requireAuth: true,
      senderId: _e.sender.id,
    }).catch(() => []);
    // Filter out force-closed overrides (auto-void etc) until cloud catches up.
    const filtered = (Array.isArray(cloudOpen) ? cloudOpen : []).filter(
      (t: any) => !isOverridden(String(t?.area || ''), String(t?.label || '')),
    );

    // If cloud no longer reports a table open, remove override entry (cloud caught up).
    try {
      const cloudKeys = new Set(
        (Array.isArray(cloudOpen) ? cloudOpen : []).map(
          (t: any) => `${String(t?.area || '')}:${String(t?.label || '')}`,
        ),
      );
      let changed = false;
      for (const k of Object.keys(closedOverride)) {
        if (!cloudKeys.has(k)) {
          delete closedOverride[k];
          changed = true;
        }
      }
      if (changed) {
        await prisma.syncState
          .upsert({
            where: { key: keyClosedOverride },
            create: { key: keyClosedOverride, valueJson: closedOverride },
            update: { valueJson: closedOverride },
          })
          .catch(() => null);
      }
    } catch {
      // ignore
    }

    return filtered;
  }
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

ipcMain.handle('tables:transfer', async (_e, payload) => {
  try {
    if (await cloudEnabledButMissingBusinessCode())
      return { ok: false, error: 'Cloud config incomplete' };
    const input = TransferTableInputSchema.parse(payload);
    // NOTE: In cloud mode, table/ticket ownership is still mirrored locally for offline and LAN UI.
    // We implement transfer locally; cloud sync can be added later if needed.
    return await transferTableLocal(input as any);
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Transfer failed') };
  }
});

// Menu syncing from remote URL removed: business admins manage menu directly.

ipcMain.handle('menu:listCategoriesWithItems', async (_e) => {
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    const cacheKey = 'cloud:menuCache';
    const readCache = async () => {
      const row = await prisma.syncState
        .findUnique({ where: { key: cacheKey } })
        .catch(() => null);
      const v: any = (row?.valueJson as any) || null;
      const cats = Array.isArray(v?.categories)
        ? v.categories
        : Array.isArray(v)
          ? v
          : [];
      return Array.isArray(cats) ? cats : [];
    };
    const writeCache = async (categories: any[]) => {
      await prisma.syncState
        .upsert({
          where: { key: cacheKey },
          create: {
            key: cacheKey,
            valueJson: { savedAt: new Date().toISOString(), categories },
          },
          update: {
            valueJson: { savedAt: new Date().toISOString(), categories },
          },
        })
        .catch(() => null);
    };
    const mergeMissingFromCache = (fresh: any[], cached: any[]) => {
      const freshCats = Array.isArray(fresh) ? fresh : [];
      const cachedCats = Array.isArray(cached) ? cached : [];
      const byCatId = new Map<number, any>();
      for (const c of freshCats) {
        const id = Number((c as any)?.id || 0);
        if (!id) continue;
        byCatId.set(id, {
          ...c,
          items: Array.isArray((c as any).items) ? [...(c as any).items] : [],
        });
      }
      // Track all items returned by cloud so we don't duplicate
      const presentItemIds = new Set<number>();
      for (const c of byCatId.values()) {
        for (const it of c.items || [])
          presentItemIds.add(Number((it as any)?.id || 0));
      }
      // If cloud endpoint still filters inactive items, keep previously-seen inactive items from cache
      for (const c of cachedCats) {
        const catId = Number((c as any)?.id || 0);
        if (!catId) continue;
        const cachedItems: any[] = Array.isArray((c as any)?.items)
          ? (c as any).items
          : [];
        const missing = cachedItems.filter(
          (it) =>
            Boolean(it) &&
            (it as any).active === false &&
            !presentItemIds.has(Number((it as any)?.id || 0)),
        );
        if (!missing.length) continue;
        const target = byCatId.get(catId) ?? { ...c, items: [] };
        target.items = Array.isArray(target.items) ? target.items : [];
        target.items.push(...missing);
        byCatId.set(catId, target);
      }
      const merged = Array.from(byCatId.values());
      for (const c of merged) {
        if (Array.isArray((c as any).items)) {
          (c as any).items.sort((a: any, b: any) =>
            String(a?.name || '').localeCompare(String(b?.name || '')),
          );
        }
      }
      return merged;
    };

    // If we're not logged in, still allow offline ordering from last cached menu.
    if (
      !hasCloudSessionForSender(_e.sender.id, cloud.businessCode) &&
      !hasCloudSession(cloud.businessCode)
    ) {
      return await readCache();
    }

    try {
      const categories = await cloudJson('GET', '/menu/categories', undefined, {
        requireAuth: true,
        senderId: _e.sender.id,
      });
      const cached = await readCache();
      const merged = mergeMissingFromCache(
        Array.isArray(categories) ? categories : [],
        cached,
      );
      await writeCache(merged);
      return merged;
    } catch (e: any) {
      if (isLikelyOfflineError(e)) return await readCache();
      return [];
    }
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    return await cloudJson('POST', '/menu/categories', input, {
      requireAuth: true,
      senderId: _e.sender.id,
    });
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    await cloudJson(
      'PUT',
      `/menu/categories/${encodeURIComponent(String(input.id))}`,
      input,
      { requireAuth: true, senderId: _e.sender.id },
    );
    return true;
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    await cloudJson(
      'DELETE',
      `/menu/categories/${encodeURIComponent(String(id))}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    );
    return true;
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    return await cloudJson('POST', '/menu/items', input, {
      requireAuth: true,
      senderId: _e.sender.id,
    });
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    await cloudJson(
      'PUT',
      `/menu/items/${encodeURIComponent(String(input.id))}`,
      input,
      { requireAuth: true, senderId: _e.sender.id },
    );
    // Update local menu cache so disabled items don't "disappear" from admin UI even if cloud endpoint filters inactive.
    try {
      const cacheKey = 'cloud:menuCache';
      const row = await prisma.syncState
        .findUnique({ where: { key: cacheKey } })
        .catch(() => null);
      const v: any = (row?.valueJson as any) || null;
      const cats: any[] = Array.isArray(v?.categories)
        ? v.categories
        : Array.isArray(v)
          ? v
          : [];
      if (Array.isArray(cats) && cats.length) {
        const next = cats.map((c: any) => {
          const items = Array.isArray(c?.items) ? c.items : [];
          return {
            ...c,
            items: items.map((it: any) =>
              Number(it?.id || 0) === Number(input.id)
                ? { ...it, ...input }
                : it,
            ),
          };
        });
        await prisma.syncState
          .upsert({
            where: { key: cacheKey },
            create: {
              key: cacheKey,
              valueJson: {
                savedAt: new Date().toISOString(),
                categories: next,
              },
            },
            update: {
              valueJson: {
                savedAt: new Date().toISOString(),
                categories: next,
              },
            },
          })
          .catch(() => null);
      }
    } catch {
      // ignore
    }
    return true;
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    throw new Error('Cloud enabled but business code missing');
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    await cloudJson(
      'DELETE',
      `/menu/items/${encodeURIComponent(String(id))}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    );
    return true;
  }
  await prisma.menuItem
    .update({ where: { id }, data: { active: false } as any })
    .catch(() => null);
  return true;
});

// Admin overview
ipcMain.handle('admin:getOverview', async (_e) => {
  if (await cloudEnabledButMissingBusinessCode()) {
    return {
      activeUsers: 0,
      openShifts: 0,
      openOrders: 0,
      lowStockItems: 0,
      queuedPrintJobs: 0,
      lastMenuSync: null,
      lastStaffSync: null,
      printerIp: null,
      appVersion: process.env.npm_package_version || '0.1.0',
      revenueTodayNet: 0,
      revenueTodayVat: 0,
    };
  }
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    // In cloud mode, if admin token is missing/invalid, force logout the admin renderer so it re-prompts for login.
    try {
      return await cloudJson('GET', '/admin/overview', undefined, {
        requireAuth: true,
        senderId: _e.sender.id,
      });
    } catch (e: any) {
      const msg = String(e?.message || e || '').toLowerCase();
      if (
        msg.includes('forbidden') ||
        msg.includes('unauthorized') ||
        msg.includes('not logged in') ||
        msg.includes('admin login required')
      ) {
        forceLogoutSender(_e.sender, String(e?.message || 'unauthorized'));
      }
      return {
        activeUsers: 0,
        openShifts: 0,
        openOrders: 0,
        lowStockItems: 0,
        queuedPrintJobs: 0,
        lastMenuSync: null,
        lastStaffSync: null,
        printerIp: null,
        appVersion: process.env.npm_package_version || '0.1.0',
        revenueTodayNet: 0,
        revenueTodayVat: 0,
      };
    }
  }
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
    const sku = String(it?.sku || '').trim();
    const stRaw = sku ? skuToStation[sku] : '';
    const st = enabled.has(String(stRaw || '').toUpperCase())
      ? String(stRaw).toUpperCase()
      : enabled.has('KITCHEN')
        ? 'KITCHEN'
        : fallbackStation;
    return { ...it, station: st };
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

    if (await cloudEnabledButMissingBusinessCode()) return false;
    const { userId, area, tableLabel, covers, items, note, idempotencyKey } =
      payload || {};
    if (!userId || !area || !tableLabel) return false;

    // Sanitize inputs
    const sanitizedArea = sanitizeString(area, 50);
    const sanitizedTableLabel = sanitizeString(tableLabel, 50);
    const sanitizedNote = note ? sanitizeString(note, 500) : null;
    const sanitizedCovers = covers ? sanitizeNumber(covers, 1, 999, 0) : null;

    // Validate items array
    if (!Array.isArray(items) || items.length === 0) return false;

    // Use sanitized values
    const sanitizedPayload = {
      userId,
      area: sanitizedArea,
      tableLabel: sanitizedTableLabel,
      covers: sanitizedCovers,
      items,
      note: sanitizedNote,
      idempotencyKey,
    };
    const cloud = await getCloudConfig().catch(() => null);
    if (cloud) {
      const idem =
        String(idempotencyKey || '').trim() ||
        `pos:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      try {
        await cloudJson(
          'POST',
          '/tickets',
          {
            userId,
            area: sanitizedArea,
            tableLabel: sanitizedTableLabel,
            covers: sanitizedCovers,
            items: items ?? [],
            note: sanitizedNote,
            idempotencyKey: idem,
          },
          { requireAuth: true },
        );
      } catch (e: any) {
        if (isLikelyOfflineError(e)) {
          await enqueueOutbox({
            id: `tickets:log:${idem}`,
            method: 'POST',
            path: '/tickets',
            body: {
              userId,
              area: sanitizedArea,
              tableLabel: sanitizedTableLabel,
              covers: sanitizedCovers,
              items: items ?? [],
              note: sanitizedNote,
              idempotencyKey: idem,
            },
            requireAuth: true,
          });
        } else {
          throw e;
        }
      }
      // Also mirror ticket logs locally so features relying on local DB (fallback reports/KDS) still work in cloud mode.
      try {
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
      } catch {
        // ignore
      }
      // Even in cloud mode, keep KDS local so the kitchen screen works offline/on-prem.
      try {
        await createKdsTicketFromLog({
          userId: Number(userId),
          area: sanitizedArea,
          tableLabel: sanitizedTableLabel,
          items: items ?? [],
          note: sanitizedNote,
        });
      } catch (e: any) {
        __kdsLastError = String(
          e?.message || e || 'Failed to create KDS ticket (cloud)',
        );
        console.error('KDS create ticket failed (cloud)', e);
      }
      return true;
    }
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
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  if (!area || !tableLabel) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    try {
      const resp: any = await cloudJson(
        'GET',
        `/tickets/latest?area=${encodeURIComponent(area)}&table=${encodeURIComponent(tableLabel)}`,
        undefined,
        { requireAuth: true, senderId: _e.sender.id },
      );
      if (!resp || typeof resp !== 'object') return resp;
      const items = Array.isArray(resp.items) ? resp.items : [];
      return { ...resp, items: items.filter((it: any) => !it?.voided) };
    } catch (e: any) {
      if (shouldForceLogoutOnError(e))
        forceLogoutSender(_e.sender, String(e?.message || 'unauthorized'));
      throw e;
    }
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  if (!area || !tableLabel) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return null;
    const q = new URLSearchParams({ area, tableLabel });
    return await cloudJson(
      'GET',
      `/tickets/tooltip?${q.toString()}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => null);
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return [];
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
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
  try {
    const settings: any = await readSettings();
    const requireApproval =
      settings?.security?.approvals?.requireManagerPinForVoid !== false;
    if (requireApproval) {
      const actor = await prisma.user
        .findUnique({ where: { id: userId } })
        .catch(() => null);
      const actorIsAdmin =
        String((actor as any)?.role || '').toUpperCase() === 'ADMIN';
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
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    try {
      await cloudJson(
        'POST',
        '/tickets/void-item',
        {
          userId,
          area,
          tableLabel,
          item,
          approvedByAdminId,
          approvedByAdminName,
        },
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        await enqueueOutbox({
          id: `tickets:void-item:${area}:${tableLabel}:${Date.now()}`,
          method: 'POST',
          path: '/tickets/void-item',
          body: {
            userId,
            area,
            tableLabel,
            item,
            approvedByAdminId,
            approvedByAdminName,
          },
          requireAuth: true,
        });
      } else {
        throw e;
      }
    }
    // Mirror locally so the UI and fallback reports reflect voids immediately.
    try {
      const last = await prisma.ticketLog
        .findFirst({
          where: { area, tableLabel },
          orderBy: { createdAt: 'desc' },
        })
        .catch(() => null);
      if (last) {
        const itemsArr = (last.itemsJson as any[]) || [];
        const idx = itemsArr.findIndex((it: any) => it.name === item.name);
        if (idx !== -1) {
          itemsArr[idx] = { ...itemsArr[idx], voided: true };
          await prisma.ticketLog
            .update({ where: { id: last.id }, data: { itemsJson: itemsArr } })
            .catch(() => null);
        }
      }
    } catch {
      // ignore
    }
    // KDS is local even in cloud mode: reflect voids immediately.
    await applyKdsVoidItem({ userId, area, tableLabel, item }).catch(
      () => false,
    );
    return true;
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
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
  try {
    const settings: any = await readSettings();
    const requireApproval =
      settings?.security?.approvals?.requireManagerPinForVoid !== false;
    if (requireApproval) {
      const actor = await prisma.user
        .findUnique({ where: { id: userId } })
        .catch(() => null);
      const actorIsAdmin =
        String((actor as any)?.role || '').toUpperCase() === 'ADMIN';
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
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    try {
      await cloudJson(
        'POST',
        '/tickets/void-ticket',
        {
          userId,
          area,
          tableLabel,
          reason,
          approvedByAdminId,
          approvedByAdminName,
        },
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        await enqueueOutbox({
          id: `tickets:void-ticket:${area}:${tableLabel}:${Date.now()}`,
          method: 'POST',
          path: '/tickets/void-ticket',
          body: {
            userId,
            area,
            tableLabel,
            reason,
            approvedByAdminId,
            approvedByAdminName,
          },
          requireAuth: true,
        });
      } else {
        throw e;
      }
    }
    // Close table locally + enqueue close for cloud if offline.
    try {
      await coreServices.setTableOpen(area, tableLabel, false);
    } catch {
      // ignore
    }
    try {
      await cloudJson(
        'POST',
        '/tables/open',
        { area, label: tableLabel, open: false },
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        await enqueueOutbox({
          id: `tables:open:${area}:${tableLabel}:${Date.now()}`,
          method: 'POST',
          path: '/tables/open',
          body: { area, label: tableLabel, open: false },
          requireAuth: true,
          dedupeKey: `tables:open:${area}:${tableLabel}`,
        });
      }
    }
    // Mirror locally: mark latest ticket items voided (best-effort)
    try {
      const last = await prisma.ticketLog
        .findFirst({
          where: { area, tableLabel },
          orderBy: { createdAt: 'desc' },
        })
        .catch(() => null);
      if (last) {
        const itemsArr = ((last.itemsJson as any[]) || []).map((it: any) => ({
          ...it,
          voided: true,
        }));
        const note2 = last.note
          ? `${last.note} | VOIDED${reason ? `: ${reason}` : ''}`
          : `VOIDED${reason ? `: ${reason}` : ''}`;
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
    // KDS is local even in cloud mode: reflect voids immediately.
    await applyKdsVoidTicket({ userId, area, tableLabel, reason }).catch(
      () => false,
    );
    return true;
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
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    const userId = Number(input?.userId || 0);
    if (!userId) return [];
    const q = new URLSearchParams();
    q.set('userId', String(userId));
    if (input?.startIso) q.set('startIso', String(input.startIso));
    if (input?.endIso) q.set('endIso', String(input.endIso));
    return await cloudJson(
      'GET',
      `/admin/tickets-by-user?${q.toString()}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    );
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return [];
    const q = new URLSearchParams();
    if (onlyUnread) q.set('onlyUnread', '1');
    return await cloudJson('GET', `/notifications?${q.toString()}`, undefined, {
      requireAuth: true,
      senderId: _e.sender.id,
    }).catch(() => []);
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    return await cloudJson(
      'POST',
      '/notifications/mark-all-read',
      {},
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => false);
  }
  const userId = Number(input?.userId);
  if (!userId) return false;
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return true;
});

ipcMain.handle('admin:listTicketCounts', async (_e, input) => {
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    const q = new URLSearchParams();
    if (input?.startIso) q.set('startIso', String(input.startIso));
    if (input?.endIso) q.set('endIso', String(input.endIso));
    try {
      return await cloudJson(
        'GET',
        `/admin/ticket-counts?${q.toString()}`,
        undefined,
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      const msg = String(e?.message || e || '').toLowerCase();
      if (
        msg.includes('forbidden') ||
        msg.includes('unauthorized') ||
        msg.includes('not logged in') ||
        msg.includes('admin login required')
      ) {
        forceLogoutSender(_e.sender, String(e?.message || 'unauthorized'));
      }
      return [];
    }
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    try {
      const q = new URLSearchParams();
      if (input?.startIso) q.set('startIso', String(input.startIso));
      if (input?.endIso) q.set('endIso', String(input.endIso));
      const path = q.toString()
        ? `/admin/shifts?${q.toString()}`
        : '/admin/shifts';
      return await cloudJson('GET', path, undefined, {
        requireAuth: true,
        senderId: _e.sender.id,
      });
    } catch (e: any) {
      const msg = String(e?.message || e || '').toLowerCase();
      if (
        msg.includes('forbidden') ||
        msg.includes('unauthorized') ||
        msg.includes('not logged in') ||
        msg.includes('admin login required')
      ) {
        forceLogoutSender(_e.sender, String(e?.message || 'unauthorized'));
      }
      return [];
    }
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    const q = new URLSearchParams();
    if (input?.onlyUnread) q.set('onlyUnread', '1');
    if (input?.limit) q.set('limit', String(input.limit));
    try {
      return await cloudJson(
        'GET',
        `/admin/notifications?${q.toString()}`,
        undefined,
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      const msg = String(e?.message || e || '').toLowerCase();
      if (
        msg.includes('forbidden') ||
        msg.includes('unauthorized') ||
        msg.includes('not logged in') ||
        msg.includes('admin login required')
      ) {
        forceLogoutSender(_e.sender, String(e?.message || 'unauthorized'));
      }
      return [];
    }
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    try {
      return await cloudJson(
        'POST',
        '/admin/notifications/mark-all-read',
        {},
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      const msg = String(e?.message || e || '').toLowerCase();
      if (
        msg.includes('forbidden') ||
        msg.includes('unauthorized') ||
        msg.includes('not logged in') ||
        msg.includes('admin login required')
      ) {
        forceLogoutSender(_e.sender, String(e?.message || 'unauthorized'));
      }
      return false;
    }
  }
  await prisma.notification.updateMany({
    where: { readAt: null },
    data: { readAt: new Date() },
  });
  return true;
});

// Top selling item today from TicketLog
ipcMain.handle('admin:getTopSellingToday', async (_e) => {
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    try {
      return await cloudJson('GET', '/admin/top-selling-today', undefined, {
        requireAuth: true,
        senderId: _e.sender.id,
      });
    } catch (e: any) {
      const msg = String(e?.message || e || '').toLowerCase();
      if (
        msg.includes('forbidden') ||
        msg.includes('unauthorized') ||
        msg.includes('not logged in') ||
        msg.includes('admin login required')
      ) {
        forceLogoutSender(_e.sender, String(e?.message || 'unauthorized'));
      }
      return null;
    }
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    return { range: input?.range || 'daily', points: [] } as any;
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
  if (await cloudEnabledButMissingBusinessCode())
    return { revenueTodayNet: 0, revenueTodayVat: 0, openOrders: 0 };
  const userId = Number(input?.userId || 0);
  if (!userId) return { revenueTodayNet: 0, revenueTodayVat: 0, openOrders: 0 };
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode))
      return { revenueTodayNet: 0, revenueTodayVat: 0, openOrders: 0 };
    return await cloudJson('GET', '/reports/my/overview', undefined, {
      requireAuth: true,
      senderId: _e.sender.id,
    }).catch(() => ({ revenueTodayNet: 0, revenueTodayVat: 0, openOrders: 0 }));
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const userId = Number(input?.userId || 0);
  if (!userId) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return null;
    return await cloudJson('GET', '/reports/my/top-selling-today', undefined, {
      requireAuth: true,
      senderId: _e.sender.id,
    }).catch(() => null);
  }
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
  if (await cloudEnabledButMissingBusinessCode())
    return { range: input?.range || 'daily', points: [] } as any;
  const userId = Number(input?.userId || 0);
  const range = (input?.range as any) || 'daily';
  if (!userId) return { range, points: [] } as any;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode))
      return { range, points: [] } as any;
    const q = new URLSearchParams({ range: String(range) });
    return await cloudJson(
      'GET',
      `/reports/my/sales-trends?${q.toString()}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => ({ range, points: [] }));
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    // Mirror locally for offline-read and queue write if offline.
    try {
      await prisma.covers.create({ data: { area, label, covers: num } });
    } catch {
      // ignore
    }
    try {
      return await cloudJson(
        'POST',
        '/covers/save',
        { area, label, covers: num },
        { requireAuth: true, senderId: _e.sender.id },
      );
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        await enqueueOutbox({
          id: `covers:save:${area}:${label}:${Date.now()}`,
          method: 'POST',
          path: '/covers/save',
          body: { area, label, covers: num },
          requireAuth: true,
          dedupeKey: `covers:save:${area}:${label}`,
        });
        return true;
      }
      return false;
    }
  }
  await prisma.covers.create({ data: { area, label, covers: num } });
  return true;
});

ipcMain.handle('covers:getLast', async (_e, { area, label }) => {
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return null;
    return await cloudJson(
      'GET',
      `/covers/last?area=${encodeURIComponent(String(area))}&label=${encodeURIComponent(String(label))}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => null);
  }
  const row = await prisma.covers.findFirst({
    where: { area, label },
    orderBy: { id: 'desc' },
  });
  return row?.covers ?? null;
});

// Layout persistence (per user, per area) via SyncState
ipcMain.handle('layout:get', async (_e, { userId, area }) => {
  if (await cloudEnabledButMissingBusinessCode()) return null;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return null;
    return await cloudJson(
      'GET',
      `/layout/get?userId=${encodeURIComponent(String(userId))}&area=${encodeURIComponent(String(area))}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => null);
  }
  const key = `layout:${userId}:${area}`;
  const row = await prisma.syncState.findUnique({ where: { key } });
  return (row?.valueJson as any)?.nodes ?? null;
});

ipcMain.handle('layout:save', async (_e, { userId, area, nodes }) => {
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    return await cloudJson(
      'POST',
      '/layout/save',
      { userId, area, nodes },
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => false);
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    return await cloudJson(
      'POST',
      '/requests/create',
      { requesterId, ownerId, area, tableLabel, items, note: note ?? null },
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => false);
  }

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
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return [];
    return await cloudJson(
      'GET',
      `/requests/list-for-owner?ownerId=${encodeURIComponent(String(ownerId))}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => []);
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    return await cloudJson(
      'POST',
      '/requests/approve',
      { id, ownerId },
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => false);
  }
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
  } catch (e) {
    void e;
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    return await cloudJson(
      'POST',
      '/requests/reject',
      { id, ownerId },
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => false);
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return [];
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return [];
    const q = new URLSearchParams({
      ownerId: String(ownerId),
      area,
      tableLabel,
    });
    return await cloudJson(
      'GET',
      `/requests/poll-approved?${q.toString()}`,
      undefined,
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => []);
  }
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
  if (await cloudEnabledButMissingBusinessCode()) return false;
  const cloud = await getCloudConfig().catch(() => null);
  if (cloud) {
    if (!hasCloudSession(cloud.businessCode)) return false;
    return await cloudJson(
      'POST',
      '/requests/mark-applied',
      { ids },
      { requireAuth: true, senderId: _e.sender.id },
    ).catch(() => false);
  }
  await prisma.ticketRequest.updateMany({
    where: { id: { in: ids }, status: 'APPROVED' as any },
    data: { status: 'APPLIED' as any, decidedAt: new Date() },
  } as any);
  return true;
});
