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
import { coreServices, withTableLock } from './services/core';
import * as reservationsService from './services/reservations';
import {
  broadcastReservationsChanged,
  broadcastTableStatusChanged,
  broadcastTicketsChanged,
  broadcastLayoutChanged,
} from './services/realtime';
import {
  effectiveVatRate,
  splitGrossVat,
  sumTicketLinesNetVat,
} from '@shared/ticketRevenue';
import {
  isVatEnabledFromSettings,
  resolveVatEnabledFromMeta,
} from '@shared/vatFromFiscal';
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
  setCloudSession,
  setCloudSessionForSender,
} from './services/cloud';
import {
  getOutboxStatus,
  startOutboxLoop,
  stopOutboxLoop,
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
import { classifyPrinterError } from './print';
import { prisma } from '@db/client';
import type { Prisma } from '@prisma/client';
import {
  expireStaleMenuStock,
  consumeMenuStockForTicketLines,
  localCalendarDateKey,
} from './services/menuStock';
import bcrypt from 'bcryptjs';
import { startApiServer } from './api';
import type * as http from 'node:http';
import type * as https from 'node:https';
import {
  startPrinterStationLoop,
  stopPrinterStationLoop,
} from './services/printerStation';
import {
  dispatchTicket,
  pickActiveReceiptProfile,
  testPrintWithProfile,
  type DispatchResult,
} from './services/printDispatcher';
import {
  maybeFiscalizePayment,
  testFiscalConnection,
  getFiscalTokenHint,
  testMinimalCloudInvoice,
} from './services/fiscal';
import {
  transferTableLocal,
  parseTransferTag,
  isTransferredOutNote,
} from './services/tableTransfer';
import { stripTransferTagsFromNote } from '@shared/utils/transferNote';
import {
  startNotificationRetentionLoop,
  stopNotificationRetentionLoop,
} from './services/notificationRetention';
import {
  syncUsersFromCloud,
  syncFromCloudAfterLogin,
  syncFromCloudManual,
} from './services/cloudSync';
import {
  formatKdsTicketListRows,
  getKdsTicketDetail,
} from './services/kdsList';
import {
  ALL_KDS_STATIONS,
  decorateKdsTicketItemsFromCategory,
  enabledStationsFromSettings,
  kdsStationsWithActiveItems,
  loadKdsRoutingFromDb,
} from './services/kdsStationRouting';
import { finalizeShiftAfterClockOut } from './services/shiftSummary';
import {
  kdsStationListWhere,
  purgeKdsDoneTicketsForStation,
  startKdsRetentionLoop,
} from './services/kdsRetention';
import {
  recallKdsTicket,
  bumpAllStationItemsInJson,
} from './services/kdsRecall';
import {
  bumpReadyKitchenItems,
  cookerBumpAllKitchenItems,
  cookerBumpSingleKitchenItem,
  isTwoStageKitchen,
} from '@shared/kdsCooker';

dotenv.config();

import {
  getCurrentSessionOwnerId,
  getTableSessionStartedAt,
} from './services/tableSession';

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
let reservationWindow: BrowserWindow | null = null;

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

let __localColumnsReady = false;

/**
 * Self-heal local-only columns on upgrade.
 *
 * A FRESH install ships a fully migrated `seed.db` (buildSeedDb runs
 * `prisma migrate deploy`). But on an UPGRADE we reuse the customer's
 * existing SQLite DB in userData, and the app does NOT run migrations on
 * boot — so columns added by recent migrations are missing, and queries
 * like `category.findMany()` crash with "no such column".
 *
 * SQLite's `ADD COLUMN` is idempotent enough for our needs: it throws
 * "duplicate column name" if it already exists, which we swallow. Each
 * statement mirrors a real migration so an old DB converges to the current
 * schema without a full migration engine in the packaged app.
 */
async function ensureLocalDbColumns(): Promise<void> {
  if (__localColumnsReady) return;
  const statements = [
    // 20260526165000_category_kds_station
    `ALTER TABLE "Category" ADD COLUMN "kdsStation" TEXT;`,
    // 20260430235907_add_category_color
    `ALTER TABLE "Category" ADD COLUMN "color" TEXT;`,
    // 20260204... MenuItem prep-station routing
    `ALTER TABLE "MenuItem" ADD COLUMN "station" TEXT NOT NULL DEFAULT 'KITCHEN';`,
    // 20260501000025_add_menuitem_iskg
    `ALTER TABLE "MenuItem" ADD COLUMN "isKg" BOOLEAN NOT NULL DEFAULT false;`,
    // 20260517174500_add_menuitem_stock_level
    `ALTER TABLE "MenuItem" ADD COLUMN "stockLevel" TEXT NOT NULL DEFAULT 'OK';`,
    // 20260517190000_menuitem_stock_qty_day
    `ALTER TABLE "MenuItem" ADD COLUMN "stockRemaining" INTEGER;`,
    `ALTER TABLE "MenuItem" ADD COLUMN "stockDay" TEXT;`,
  ];
  for (const sql of statements) {
    try {
      await (prisma as any).$executeRawUnsafe(sql);
    } catch {
      // Column already exists (duplicate column name) — expected on
      // already-migrated DBs; ignore and continue.
    }
  }
  __localColumnsReady = true;
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

  const onMainFailLoad = (_e: any, ec: number, ed: string, vu: string) => {
    console.error('Renderer failed load', { ec, ed, vu });
  };
  mainWindow.webContents.on('did-fail-load', onMainFailLoad);

  const mainWcId = mainWindow.webContents.id;
  mainWindow.on('closed', () => {
    try {
      mainWindow?.webContents.removeListener('did-fail-load', onMainFailLoad);
    } catch {
      // ignore
    }
    cleanupSenderRateLimits(mainWcId);
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
  // SECURITY/MEM: rate limits are keyed by webContents.id (event.sender.id),
  // not BrowserWindow.id. Capture it now before the window is gone.
  const adminWcId = adminWindow.webContents.id;
  adminWindow.on('closed', () => {
    cleanupSenderRateLimits(adminWcId);
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

function createReservationWindow() {
  if (reservationWindow) {
    reservationWindow.focus();
    return;
  }
  reservationWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#111827',
    title: 'Reservations -  Code Orbit POS',
    ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH,
    },
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) reservationWindow.loadURL(url + '#/reservations');
  else
    reservationWindow.loadFile(RENDERER_INDEX_HTML, {
      hash: '/reservations',
    });
  // Match admin window: capture webContents.id for rate-limit cleanup BEFORE close.
  const wcId = reservationWindow.webContents.id;
  reservationWindow.on('closed', () => {
    cleanupSenderRateLimits(wcId);
    reservationWindow = null;
  });
  registerUpdateListener(reservationWindow);
}

let kdsAutoBumpTimer: NodeJS.Timeout | null = null;
let kdsAutoBumpRunning = false;
function startKdsAutoBumpLoop() {
  if (kdsAutoBumpTimer) return;
  // Auto-bump stale KDS tickets so they don't sit in NEW forever (e.g. forgotten open tables).
  // Requirement: bump anything left open for > 12 hours.
  const cutoffMs = 12 * 60 * 60 * 1000;
  const intervalMs = 60 * 60 * 1000; // hourly

  const runOnce = async () => {
    if (kdsAutoBumpRunning) return; // overlap guard if a previous tick is still in flight
    kdsAutoBumpRunning = true;
    try {
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
    } finally {
      kdsAutoBumpRunning = false;
    }
  };

  void runOnce();
  kdsAutoBumpTimer = setInterval(() => void runOnce(), intervalMs);
}
function stopKdsAutoBumpLoop() {
  if (kdsAutoBumpTimer) {
    clearInterval(kdsAutoBumpTimer);
    kdsAutoBumpTimer = null;
  }
}

let autoVoidTimer: NodeJS.Timeout | null = null;
let autoVoidRunning = false;

let autoCloseShiftsTimer: NodeJS.Timeout | null = null;
let autoCloseShiftsRunning = false;

let autoNoShowReservationsTimer: NodeJS.Timeout | null = null;
let autoNoShowReservationsRunning = false;
function startAutoVoidStaleTicketsLoop() {
  if (autoVoidTimer) return;
  // Auto-void any *open* tables whose session exceeds 12 hours.
  // This helps avoid "ghost" open tickets after long downtime and keeps KDS clean.
  const cutoffMs = 12 * 60 * 60 * 1000;
  const intervalMs = 60 * 60 * 1000; // hourly
  const reason = 'Auto-void: ticket exceeded 12 hours';

  const runOnce = async () => {
    if (autoVoidRunning) return; // overlap guard
    autoVoidRunning = true;
    // CORRECTNESS: previously referenced an undefined `cloud` symbol. Look up
    // cloud config once per tick; in cloud mode the admin notification feed
    // is cloud-backed, so we suppress duplicate local notifications.
    const cloud = await getCloudConfig().catch(() => null);
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
        // Hold the per-table lock around both writes so a concurrent
        // `tickets:log` from a stale device cannot insert between the
        // open-map flip and the openAt cleanup.
        try {
          await withTableLock(area, tableLabel, async () => {
            await coreServices.setTableOpen(area, tableLabel, false);
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
          });
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
    } finally {
      autoVoidRunning = false;
    }
  };

  void runOnce();
  autoVoidTimer = setInterval(() => void runOnce(), intervalMs);
}
function stopAutoVoidStaleTicketsLoop() {
  if (autoVoidTimer) {
    clearInterval(autoVoidTimer);
    autoVoidTimer = null;
  }
}

// Auto-close idle waiter shifts after a configurable retention period (12h / 24h).
// Important guarantees:
// - Only runs when admin has enabled `preferences.autoCloseShift.enabled`.
// - A shift is closed only when the user has NO open tickets (no open table where
//   the latest ticket log row was written by them). This avoids losing in-progress
//   work for staff who genuinely had a long service.
// - The user that "closes" the shift is set to the openedById, so the ledger
//   shows a self-clock-out (rather than spoofing an admin id we don't have).
// - We also drop the in-memory rate-limit/security counters and emit an OTHER
//   notification so admins can see why a shift was force-closed.
function startAutoCloseShiftsLoop() {
  if (autoCloseShiftsTimer) return;
  // Check every 15 minutes — auto-close is best-effort retention, not a real-time gate.
  const intervalMs = 15 * 60 * 1000;

  const runOnce = async () => {
    if (autoCloseShiftsRunning) return;
    autoCloseShiftsRunning = true;
    try {
      const settings = await coreServices
        .readSettings()
        .catch(() => null as any);
      const cfg = (settings as any)?.preferences?.autoCloseShift || {};
      if (!cfg?.enabled) return;
      const hoursRaw = Number(cfg?.hours ?? 0);
      // Only allow 12 or 24 — anything else is treated as disabled to avoid
      // an admin accidentally setting a 1-minute window via direct DB edit.
      const hours = hoursRaw === 12 || hoursRaw === 24 ? hoursRaw : 0;
      if (!hours) return;

      const cutoffMs = hours * 60 * 60 * 1000;
      const now = Date.now();

      type OpenShiftRow = { id: number; openedAt: Date; openedById: number };
      const openShifts: OpenShiftRow[] = await prisma.dayShift
        .findMany({
          where: { closedAt: null },
          select: { id: true, openedAt: true, openedById: true },
        })
        .catch(() => [] as OpenShiftRow[]);
      if (!openShifts.length) return;

      const stale = openShifts.filter(
        (s: OpenShiftRow) => now - new Date(s.openedAt).getTime() > cutoffMs,
      );
      if (!stale.length) return;

      // Determine which open tables belong to which user (by latest ticket-log owner).
      // Read the open-tables map once; if there are no open tables, no shift can be
      // blocked by an "open ticket".
      const openRow = await prisma.syncState
        .findUnique({ where: { key: 'tables:open' } })
        .catch(() => null);
      const openMap = ((openRow?.valueJson as any) || {}) as Record<
        string,
        boolean
      >;
      const openTableKeys = Object.entries(openMap)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k);

      // Map userId -> has at least one open ticket
      const usersWithOpenTickets = new Set<number>();
      if (openTableKeys.length) {
        for (const key of openTableKeys) {
          const [area, tableLabel] = String(key).split(':');
          if (!area || !tableLabel) continue;
          const last = await prisma.ticketLog
            .findFirst({
              where: { area, tableLabel },
              orderBy: { createdAt: 'desc' },
              select: { userId: true },
            })
            .catch(() => null);
          if (last?.userId) usersWithOpenTickets.add(Number(last.userId));
        }
      }

      const cloud = await getCloudConfig().catch(() => null);

      for (const s of stale) {
        // Hard guard: never close a shift while the user still has an open ticket.
        if (usersWithOpenTickets.has(Number(s.openedById))) continue;
        try {
          await prisma.dayShift.update({
            where: { id: s.id },
            data: { closedAt: new Date(), closedById: s.openedById },
          });
          // Best-effort notification (only locally; cloud mode mirrors via its own feed).
          if (!cloud) {
            await prisma.notification
              .create({
                data: {
                  userId: s.openedById,
                  type: 'OTHER' as any,
                  message: `Shift auto-closed after ${hours}h of inactivity (no open tickets).`,
                } as any,
              })
              .catch(() => {});
            const admins = await prisma.user
              .findMany({
                where: { role: 'ADMIN', active: true },
                select: { id: true },
              } as any)
              .catch(() => [] as { id: number }[]);
            for (const a of admins as { id: number }[]) {
              if (Number(a.id) === Number(s.openedById)) continue;
              await prisma.notification
                .create({
                  data: {
                    userId: a.id,
                    type: 'OTHER' as any,
                    message: `Auto-closed shift #${s.id} (user ${s.openedById}) after ${hours}h.`,
                  } as any,
                })
                .catch(() => {});
            }
          }
        } catch {
          // ignore — best effort
        }
      }
    } catch {
      // ignore — best effort
    } finally {
      autoCloseShiftsRunning = false;
    }
  };

  void runOnce();
  autoCloseShiftsTimer = setInterval(() => void runOnce(), intervalMs);
}

function stopAutoCloseShiftsLoop() {
  if (autoCloseShiftsTimer) {
    clearInterval(autoCloseShiftsTimer);
    autoCloseShiftsTimer = null;
  }
}

// Auto-mark BOOKED reservations as NO_SHOW after a configurable grace period
// past their start time. This frees the table on the floor automatically while
// keeping the row in the List view so the host still has a record.
//
// Hard guarantees:
// - Only runs when admin has enabled `preferences.reservationAutoNoShow.enabled`.
// - Grace minutes are clamped to [5, 240]; anything outside that disables the loop.
// - Only BOOKED reservations are touched. SEATED/COMPLETED/CANCELLED are never
//   transitioned (a seated guest who's still there isn't a no-show, etc).
// - Best-effort notifications go to the reservation's creator and any active
//   ADMIN/HOST users; failures are swallowed so a bad notification can't block
//   the status flip.
function startAutoNoShowReservationsLoop() {
  if (autoNoShowReservationsTimer) return;
  // Run every minute. The work is a single indexed query on a small table.
  const intervalMs = 60 * 1000;

  const runOnce = async () => {
    if (autoNoShowReservationsRunning) return;
    autoNoShowReservationsRunning = true;
    try {
      const settings = await coreServices
        .readSettings()
        .catch(() => null as any);
      const cfg = (settings as any)?.preferences?.reservationAutoNoShow || {};
      if (!cfg?.enabled) return;
      const minsRaw = Number(cfg?.minutes ?? 0);
      const minutes =
        Number.isFinite(minsRaw) && minsRaw >= 5 && minsRaw <= 240
          ? Math.round(minsRaw)
          : 0;
      if (!minutes) return;

      const cutoff = new Date(Date.now() - minutes * 60_000);

      type StaleRow = {
        id: number;
        area: string;
        tableLabel: string | null;
        customerName: string;
        startsAt: Date;
        createdById: number;
      };
      const stale: StaleRow[] = await prisma.reservation
        .findMany({
          where: {
            status: 'BOOKED' as any,
            startsAt: { lte: cutoff },
          },
          select: {
            id: true,
            area: true,
            tableLabel: true,
            customerName: true,
            startsAt: true,
            createdById: true,
          },
          take: 200,
        })
        .catch(() => [] as StaleRow[]);
      if (!stale.length) return;

      const ids = stale.map((r) => r.id);
      await prisma.reservation
        .updateMany({
          where: {
            id: { in: ids },
            status: 'BOOKED' as any, // re-check to avoid races with manual updates
          },
          data: { status: 'NO_SHOW' as any },
        })
        .catch(() => null);

      // Push a real-time invalidation to every client so the floor view
      // colour and list status update without waiting for a poll/refresh.
      for (const r of stale) {
        try {
          broadcastReservationsChanged({
            kind: 'auto-no-show',
            id: Number(r.id),
            dateIso: new Date(r.startsAt).toISOString(),
            area: r.area,
            status: 'NO_SHOW',
          });
        } catch {
          // ignore — best effort
        }
      }

      // Notify creators + all active hosts/admins so the floor team sees it.
      const cloud = await getCloudConfig().catch(() => null);
      if (!cloud) {
        const recipients = await prisma.user
          .findMany({
            where: {
              active: true,
              role: { in: ['ADMIN', 'HOST'] as any },
            } as any,
            select: { id: true },
          })
          .catch(() => [] as { id: number }[]);
        const recipientIds = new Set<number>(
          (recipients as { id: number }[]).map((u) => Number(u.id)),
        );
        for (const r of stale) {
          if (r.createdById) recipientIds.add(Number(r.createdById));
          const startedAt = new Date(r.startsAt);
          const hh = String(startedAt.getHours()).padStart(2, '0');
          const mm = String(startedAt.getMinutes()).padStart(2, '0');
          const where = r.tableLabel ? `${r.area} · ${r.tableLabel}` : r.area;
          const msg = `No-show: ${r.customerName} (${hh}:${mm} on ${where}) auto-marked after ${minutes} min grace.`;
          for (const uid of recipientIds) {
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
      }
    } catch {
      // ignore — best effort
    } finally {
      autoNoShowReservationsRunning = false;
    }
  };

  void runOnce();
  autoNoShowReservationsTimer = setInterval(() => void runOnce(), intervalMs);
}

function stopAutoNoShowReservationsLoop() {
  if (autoNoShowReservationsTimer) {
    clearInterval(autoNoShowReservationsTimer);
    autoNoShowReservationsTimer = null;
  }
}

let apiServers: {
  http: http.Server | null;
  https: https.Server | null;
} | null = null;

app.whenReady().then(async () => {
  // Set macOS dock icon (BrowserWindow icon doesn't affect dock on macOS)
  if (process.platform === 'darwin' && APP_ICON_PATH) {
    try {
      const { nativeImage } = await import('electron');
      const img = nativeImage.createFromPath(APP_ICON_PATH);
      if (!img.isEmpty()) app.dock?.setIcon(img);
    } catch {
      // ignore — dock icon stays default
    }
  }
  // Heal local-only columns BEFORE the window (and its IPC queries) load, so
  // an upgraded DB missing recent columns (e.g. Category.kdsStation) doesn't
  // crash menu/category queries.
  await ensureLocalDbColumns().catch((e) =>
    console.warn('[startup] ensureLocalDbColumns failed:', e),
  );
  createWindow();
  setupAutoUpdater();
  apiServers = await startApiServer();
  // Advertise the LAN API server on mDNS so the standalone KDS app
  // (and future LAN waiter apps) can auto-discover the POS host. Pure
  // JS implementation — no native deps, safe to fail.
  try {
    const { startMdnsAdvertiser } = await import('./services/mdnsAdvertiser');
    const settings = await coreServices.readSettings().catch(() => ({}) as any);
    const businessCode = String(
      (settings as any)?.cloud?.businessCode || '',
    ).trim();
    void startMdnsAdvertiser({
      httpPort: 3333,
      httpsPort: 3443,
      appVersion: app.getVersion(),
      businessCode,
    });
  } catch {
    // ignore — discovery is a convenience, not required
  }
  // In cloud mode, also act as an on-prem Printer Station (pull queued print jobs and print locally).
  startPrinterStationLoop();
  // Offline outbox: retry queued cloud writes when connectivity returns.
  startOutboxLoop();
  // Notifications: automatically delete notifications older than 1 week (DB retention).
  startNotificationRetentionLoop(prisma, { days: 7 });
  startKdsRetentionLoop(prisma, { intervalMs: 60 * 1000 });
  // KDS: auto-bump stale tickets after 12 hours.
  startKdsAutoBumpLoop();
  // Tickets: auto-void stale open tables after 12 hours + notify.
  startAutoVoidStaleTicketsLoop();
  // Shifts: optional auto-close idle waiter shifts (12h / 24h) when no open tickets.
  startAutoCloseShiftsLoop();
  // Reservations: optional auto-mark BOOKED reservations as NO_SHOW after grace.
  startAutoNoShowReservationsLoop();
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

let isShuttingDown = false;
app.on('before-quit', async (event) => {
  // Allow Electron to call this multiple times; only do real work once.
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Always synchronously cancel timers/listeners that don't need to await anything.
  cleanupUpdater();
  stopMemoryMonitoring();
  stopNotificationRetentionLoop();
  stopKdsAutoBumpLoop();
  stopAutoVoidStaleTicketsLoop();
  stopAutoCloseShiftsLoop();
  stopAutoNoShowReservationsLoop();
  stopPrinterStationLoop();
  stopOutboxLoop();
  try {
    const { stopMdnsAdvertiser } = await import('./services/mdnsAdvertiser');
    await stopMdnsAdvertiser();
  } catch {
    // ignore
  }
  try {
    // Lazy import to avoid a circular reference at module load.
    const sec = await import('./services/security');
    sec.stopRateLimitSweeper?.();
  } catch {
    // ignore
  }

  // Async work below — defer the actual quit until our cleanup completes so we
  // don't leave open SQLite handles / TCP listeners.
  event.preventDefault();
  try {
    await Promise.race([
      Promise.all([
        new Promise<void>((resolve) => {
          if (!apiServers?.http) return resolve();
          apiServers.http.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          if (!apiServers?.https) return resolve();
          apiServers.https.close(() => resolve());
        }),
        prisma.$disconnect().catch(() => undefined),
      ]),
      // Don't block quit forever if something is stuck.
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    // ignore — we are quitting anyway
  } finally {
    app.exit(0);
  }
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
          },
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
          await syncFromCloudAfterLogin(loginRes.token, loginRes.user.id, pin);
          const userData = {
            id: user.id,
            displayName: user.displayName,
            role: user.role,
            active: user.active,
            createdAt: user.createdAt.toISOString(),
          };
          setSentryUser(user.id, user.displayName, user.role);
          addBreadcrumb(
            'User logged in via cloud (synced to local)',
            'auth',
            'info',
          );
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
  const failMap: Map<
    number,
    { count: number; resetAt: number; lastAlertAt: number }
  > = g.__mgrPinFailBySender;
  const cur = failMap.get(senderId);
  if (!cur || cur.resetAt <= now) {
    failMap.set(senderId, {
      count: 0,
      resetAt: now + windowMinutes * 60 * 1000,
      lastAlertAt: cur?.lastAlertAt || 0,
    });
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
  if (
    st.count >= threshold &&
    (!st.lastAlertAt || now - st.lastAlertAt > cooldownMinutes * 60 * 1000)
  ) {
    const msg =
      `Unusual activity (auto-check): ${st.count} manager PIN verification failures in the last ${windowMinutes} minutes. ` +
      `This can be normal (mistyped PINs); please review if unexpected.`;
    for (const a of admins as any[]) {
      await prisma.notification
        .create({
          data: {
            userId: (a as any).id,
            type: 'SECURITY' as any,
            message: msg,
          } as any,
        })
        .catch(() => {});
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
        addBreadcrumb(
          `Cloud user sync failed: ${syncResult.error}`,
          'auth',
          'warning',
        );
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

ipcMain.handle('shifts:clockOut', async (_e, { userId, force }) => {
  const open = await prisma.dayShift.findFirst({
    where: { closedAt: null, openedById: userId },
  });
  if (!open) return null;

  // Refuse to clock out if the waiter still has open tables under
  // their name. Letting them go home leaves the floor with "ghost"
  // ownership: the table appears active, but the owner is off-shift,
  // so transfers / void approvals can't auto-find them and other
  // waiters can't append items (post-PR ownership guard above). The
  // `force: true` opt-in is reserved for the admin "close shift" UI
  // and skips the check after explicit confirmation.
  if (!force) {
    const openTables: Array<{ area: string; label: string }> = [];
    try {
      const openRow = await prisma.syncState
        .findUnique({ where: { key: 'tables:open' } })
        .catch(() => null);
      const openMap = ((openRow?.valueJson as any) || {}) as Record<
        string,
        boolean
      >;
      const keys = Object.entries(openMap)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k);

      // Pull the latest ticket-log row per open table and only count
      // those whose current owner matches the user clocking out. This
      // is at most ~50 rows in a busy service so a sequential scan is
      // fine; we can swap to a single GROUP BY query later if we need
      // to.
      for (const key of keys) {
        const idx = key.indexOf(':');
        if (idx <= 0) continue;
        const area = key.slice(0, idx);
        const label = key.slice(idx + 1);
        const last = await prisma.ticketLog
          .findFirst({
            where: { area, tableLabel: label },
            orderBy: { createdAt: 'desc' },
            select: { userId: true },
          })
          .catch(() => null);
        if (last && Number(last.userId) === Number(userId)) {
          openTables.push({ area, label });
        }
      }
    } catch {
      // If the lookup itself fails we fall through and clock out — we
      // never want a transient DB hiccup to trap a waiter at work.
    }

    if (openTables.length > 0) {
      return {
        ok: false,
        error: `You still have ${openTables.length} open table${openTables.length === 1 ? '' : 's'}. Close or transfer them before clocking out.`,
        code: 'OPEN_TABLES_OWNED',
        openTables,
      };
    }
  }

  const closedAt = new Date();
  const updated = await prisma.dayShift.update({
    where: { id: open.id },
    data: { closedAt, closedById: userId },
  });
  void finalizeShiftAfterClockOut({
    shiftId: updated.id,
    userId,
    openedAt: open.openedAt,
    closedAt,
  }).catch((e) => console.warn('[shifts:clockOut] shift print failed:', e));
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
    'https://code-orbit-agroturizem.com/api/staff';
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
  if (result?.fiscal && typeof result.fiscal === 'object') {
    result.fiscal = { ...result.fiscal };
    if (result.fiscal.authToken) {
      result.fiscal.authTokenConfigured = true;
      delete result.fiscal.authToken;
    }
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
  return await readSettings();
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

ipcMain.handle('settings:testFiscalConnection', async () => {
  const settings = await coreServices.readSettings();
  return await testFiscalConnection(settings as any);
});

ipcMain.handle('settings:getFiscalTokenHint', async () => {
  const settings = await coreServices.readSettings();
  return getFiscalTokenHint(settings as any);
});

ipcMain.handle('settings:testFiscalMinimalInvoice', async () => {
  const settings = await coreServices.readSettings();
  return await testMinimalCloudInvoice(settings as any);
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
    const profile = pickActiveReceiptProfile(settings as any);
    if (!profile) return false;
    const r = await testPrintWithProfile(profile, settings as any);
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

// Test-print to a SPECIFIC profile (network/USB/serial) without
// persisting anything. Powers the per-profile "Test print" button on
// the Admin → Settings → Printer screen so an admin can validate
// IP/port/USB/serial changes BEFORE saving them.
ipcMain.handle(
  'settings:testPrintProfile',
  async (_evt, profile): Promise<{ ok: boolean; error?: string }> => {
    try {
      if (!profile || typeof profile !== 'object') {
        return { ok: false, error: 'Missing printer profile.' };
      }
      const settings = await readSettings();
      return await testPrintWithProfile(profile, settings as any);
    } catch (e: any) {
      return {
        ok: false,
        error: String(e?.message || e || 'Test print failed'),
      };
    }
  },
);

ipcMain.handle('settings:testPrintVerbose', async () => {
  try {
    const settings = await readSettings();
    const profile = pickActiveReceiptProfile(settings as any);
    if (!profile) {
      return { ok: false, error: 'No printer configured' };
    }
    const r = await testPrintWithProfile(profile, settings as any);
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
    return r;
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

// PR 3: expose the printer-retry queue so a future "Pending prints"
// admin UI (or a sync-status badge) can list and cancel pending
// retries. Read-only listing is safe to leave open; cancel requires
// at least an admin role check at the IPC boundary so a compromised
// renderer can't silently drop the kitchen's tickets — for now we
// gate it behind requireAuth which already exists upstream of these
// handlers (callers from the staff UI will pass through that path).
ipcMain.handle('print:listRetries', async () => {
  const rows = await prisma.printJob
    .findMany({
      where: { status: { in: ['RETRY', 'FAILED'] as any } },
      orderBy: [{ status: 'asc' }, { nextAttemptAt: 'asc' }, { id: 'desc' }],
      take: 100,
    })
    .catch(() => []);
  return rows.map((r: any) => ({
    id: Number(r.id),
    status: String(r.status),
    type: String(r.type),
    attempts: Number(r.attempts || 0),
    lastError: r.lastError ? String(r.lastError) : null,
    nextAttemptAt: r.nextAttemptAt
      ? new Date(r.nextAttemptAt).toISOString()
      : null,
    printerProfileId: r.printerProfileId ? String(r.printerProfileId) : null,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
});

ipcMain.handle('print:cancelRetry', async (_e, payload) => {
  const id = Number((payload as any)?.id || 0);
  if (!id) return { ok: false, error: 'missing id' };
  await prisma.printJob
    .update({
      where: { id },
      data: {
        status: 'FAILED' as any,
        lastError: 'cancelled by user',
        nextAttemptAt: null,
      } as any,
    })
    .catch(() => {});
  return { ok: true };
});

ipcMain.handle('system:openExternal', async (_e, payload) => {
  try {
    const url = String((payload as any)?.url || '').trim();
    if (!url) return false;
    // SECURITY: only allow http/https/mailto. Reject file:, javascript:, custom protocols, etc.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const allowed = new Set(['http:', 'https:', 'mailto:']);
    if (!allowed.has(parsed.protocol)) return false;
    await shell.openExternal(parsed.toString());
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
  const idempotencyKey = String((input as any)?.idempotencyKey ?? '').trim();
  if (idempotencyKey) {
    const existing = await prisma.printJob
      .findFirst({
        where: { idempotencyKey } as any,
      })
      .catch(() => null);
    if (existing) {
      // Same logical payment/print already recorded — retries must not
      // duplicate notifications, audit PrintJobs, or dispatch again.
      return true;
    }
  }

  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  const items = (input?.items as any[]) || [];
  const recordOnly = Boolean((input as any)?.recordOnly);
  const meta = ((input as any)?.meta as any) || null;
  if (!area || !tableLabel || items.length === 0) return false;

  // Local-first: print directly via local PrintJob
  let payload = {
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

  // Use internal settings (includes fiscal auth token). `readSettings()`
  // strips secrets before sending to the renderer.
  const settings = await coreServices.readSettings();
  const kind = String(meta?.kind || '').toUpperCase();
  if (kind === 'PAYMENT') {
    try {
      payload = await maybeFiscalizePayment(payload, settings as any, {
        idempotencyKey: idempotencyKey || undefined,
      });
      const fiscalWarning = String(
        (payload as any)?.meta?.fiscalWarning || '',
      ).trim();
      if (fiscalWarning) {
        broadcastPrinterEvent({
          level: 'warn',
          kind: 'fiscal',
          message: fiscalWarning,
          detail: fiscalWarning,
          at: Date.now(),
          context: { area, tableLabel, kind: 'PAYMENT' },
        });
      }
    } catch (e: any) {
      const msg = String(e?.message || 'Fiskalizimi failed.');
      broadcastPrinterEvent({
        level: 'error',
        kind: 'fiscal',
        message: msg,
        detail: msg,
        at: Date.now(),
        context: { area, tableLabel, kind: 'PAYMENT' },
      });
      try {
        const uid = Number(meta?.userId || 0);
        if (uid) {
          await prisma.notification.create({
            data: {
              userId: uid,
              type: 'OTHER' as any,
              message: `Fiskalizimi failed on ${area} Table ${tableLabel}: ${msg}`,
            } as any,
          });
        }
      } catch {
        // ignore
      }
      return false;
    }
  }

  // recordOnly = store receipt snapshot for history without printing.
  if (recordOnly) {
    try {
      await prisma.printJob.create({
        data: {
          type: 'RECEIPT' as any,
          payloadJson: payload,
          status: 'SENT' as any,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        } as any,
      });
      return true;
    } catch (e: any) {
      if (e?.code === 'P2002' && idempotencyKey) return true;
      return false;
    }
  }

  // All the actual ESC/POS dispatch + routing lives in
  // `printDispatcher.ts`. This handler keeps only the side effects:
  // notifications + PrintJob history record.
  const result: DispatchResult = await dispatchTicket(
    payload,
    settings as any,
    // Persist transient failures into the RETRY queue (PR 3) so the
    // printer-station loop can keep trying for ~4 min. The waiter
    // still sees the immediate error toast — the queue is a quiet
    // safety net for "actually, the kitchen printer came back 12 s
    // later".
    { persistRetryOnTransientFailure: true },
  );
  const ok = result.ok;
  const failCount = result.failures;
  const firstErr = result.firstError ?? null;

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
  // Store a PrintJob record (useful for receipt history). SENT/FAILED
  // here just tracks the synchronous outcome; the QUEUED status is
  // reserved for jobs the cloud poller hasn't picked up yet.
  try {
    await prisma.printJob.create({
      data: {
        type: 'RECEIPT' as any,
        payloadJson: payload,
        status: ok ? ('SENT' as any) : ('FAILED' as any),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as any,
    });
  } catch (e: any) {
    if (e?.code === 'P2002' && idempotencyKey) {
      // Concurrent identical payment — treat as success (other call won).
    } else {
      // ignore
    }
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
    const activeSettings = await readSettings().catch(() => ({}));
    const activeVatEnabled = isVatEnabledFromSettings(activeSettings);

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
          // Cap per-table active ticket history. Even very long sessions rarely
          // exceed a few hundred log rows; this prevents pathological loads.
          prisma.ticketLog
            .findMany({ where, orderBy: { createdAt: 'asc' }, take: 500 })
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
        const { net: subtotal, vat } = sumTicketLinesNetVat(
          items,
          activeVatEnabled,
          Number((activeSettings as any)?.defaultVatRate || 0),
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
          vatEnabled: activeVatEnabled,
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
    // Only the ORIGINAL payment-audit row (written by `tickets:print`)
    // has `attempts = 0`. The printer-offline retry queue persists a
    // separate PrintJob per backoff tick via `enqueuePrintRetry` with
    // `attempts >= 1`. Those carry the same payload (incl.
    // `meta.kind = 'PAYMENT'`) but represent re-print attempts, not new
    // payments — without this guard, a single payment made while the
    // printer is offline would surface as N "paid tickets" in the
    // waiter report.
    const jobs = await prisma.printJob
      .findMany({
        where: { type: 'RECEIPT' as any, attempts: 0 } as any,
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
      .catch(() => []);

    const paymentSettings = await readSettings().catch(() => ({}));
    const out: any[] = [];
    for (const j of jobs as any[]) {
      const p = (j.payloadJson as any) || {};
      const meta = (p?.meta as any) || {};
      if (String(meta?.kind || '') !== 'PAYMENT') continue;
      if (Number(meta?.userId || 0) !== Number(userId)) continue;
      // Defense-in-depth: if a future migration drops the where clause
      // or pre-PR-3 rows lack `attempts`, treat anything with
      // attempts > 0 as a print retry, not a payment.
      if (Number((j as any)?.attempts || 0) > 0) continue;
      const area = String(p.area || '');
      const tableLabel = String(p.tableLabel || '');
      const items = Array.isArray(p.items) ? p.items : [];
      const note = p.note ?? null;
      const covers = (p.covers ?? null) as any;
      const userName = p.userName ?? null;
      const paymentMethod = (meta.method ?? null) as any;
      const paidAt = meta.paidAt ?? j.createdAt.toISOString();
      const vatEnabled = resolveVatEnabledFromMeta(meta, paymentSettings);
      const { net: subtotal, vat } = sumTicketLinesNetVat(
        items,
        vatEnabled,
        Number((paymentSettings as any)?.defaultVatRate || 0),
      );
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

    const voidSettings = await readSettings().catch(() => ({}));
    const voidVatEnabled = isVatEnabledFromSettings(voidSettings);
    const voidDefaultVatRate = Number(
      (voidSettings as any)?.defaultVatRate || 0,
    );

    const out: any[] = [];
    for (const r of rows as any[]) {
      if (Number(r.userId) !== Number(userId)) continue;
      // Transferred-out rows carry an exact copy of the destination's
      // items (the transfer flow duplicates `itemsJson`); skipping them
      // here prevents voided items from being reported twice in the
      // waiter's voided-tickets list.
      if (isTransferredOutNote(r.note)) continue;
      const itemsAll = Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [];
      const voidedItems = itemsAll.filter((it: any) => it?.voided === true);
      if (voidedItems.length === 0) continue;

      const note = String(r.note || '');
      const isFullVoid = itemsAll.every((it: any) => it?.voided === true);
      const u = await prisma.user
        .findUnique({ where: { id: r.userId } })
        .catch(() => null);

      const grossSubtotal = voidedItems.reduce(
        (s: number, it: any) =>
          s + Number(it.unitPrice || 0) * Number(it.qty || 1),
        0,
      );
      const vat = voidVatEnabled
        ? voidedItems.reduce((s: number, it: any) => {
            const lineGross = Number(it.unitPrice || 0) * Number(it.qty || 1);
            const rate = effectiveVatRate(it.vatRate, voidDefaultVatRate);
            return s + splitGrossVat(lineGross, rate).vat;
          }, 0)
        : 0;
      const subtotal = grossSubtotal - vat;

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
        total: grossSubtotal,
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

  // All of these mutations belong to the same logical "session edge" for
  // the table — `tables:open`, `tables:openAt`, and the active KDS order.
  // We serialize them under the per-table lock used by
  // `coreServices.setTableOpen` so a concurrent transfer / close from
  // another device can't interleave half of one operation with half of
  // another and leave inconsistent state behind.
  return withTableLock(area, label, async () => {
    await coreServices.setTableOpen(area, label, open);
    // Push the change to every other client (other Electron windows +
    // mobile tablets via SSE). Without this, opening / closing a table
    // on one device would leave the others showing stale colours until
    // the next 12-15s poll.
    try {
      broadcastTableStatusChanged({ area, label, open });
    } catch {
      // ignore — best effort
    }
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

function normalizeMenuStockLevel(raw: unknown): 'OK' | 'LOW' | 'OUT' {
  const s = String(raw ?? 'OK').toUpperCase();
  if (s === 'LOW') return 'LOW';
  if (s === 'OUT') return 'OUT';
  return 'OK';
}

// Local-first: always use local DB for menu
ipcMain.handle('menu:listCategoriesWithItems', async (_e) => {
  await expireStaleMenuStock(prisma);
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
    kdsStation: (c as any)?.kdsStation ?? null,
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
      stockLevel: normalizeMenuStockLevel((i as any)?.stockLevel),
      stockRemaining:
        i.stockRemaining != null && Number.isFinite(Number(i.stockRemaining))
          ? Number(i.stockRemaining)
          : null,
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
      kdsStation: (input as any).kdsStation ?? null,
    } as any,
  });
  return { id: created.id };
});

ipcMain.handle('menu:updateCategory', async (_e, payload) => {
  const input = UpdateMenuCategoryInputSchema.parse(payload);
  const data: any = {
    ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
    ...(typeof input.sortOrder === 'number'
      ? { sortOrder: input.sortOrder }
      : {}),
    ...((input as any).color !== undefined
      ? { color: (input as any).color }
      : {}),
    ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
    ...((input as any).kdsStation !== undefined
      ? { kdsStation: (input as any).kdsStation }
      : {}),
  };
  await prisma.category.update({
    where: { id: input.id },
    data,
  });
  if ((input as any).kdsStation) {
    await prisma.menuItem.updateMany({
      where: { categoryId: input.id },
      data: { station: (input as any).kdsStation },
    });
  }
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

function slugifySku(name: string): string {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop diacritics (ç, ë, …)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'ITEM';
}

// SKU is unique. Build a candidate from an explicit sku (or the name) and
// resolve collisions by appending a counter, so bulk imports with duplicate
// or pre-existing names never crash on the unique constraint.
async function nextAvailableSku(preferred: string): Promise<string> {
  const base = slugifySku(preferred);
  for (let i = 0; i < 200; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await prisma.menuItem.findUnique({
      where: { sku: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

ipcMain.handle('menu:createItem', async (_e, payload) => {
  const input = CreateMenuItemInputSchema.parse(payload);
  const category = await prisma.category.findUnique({
    where: { id: Number(input.categoryId) },
    select: { kdsStation: true },
  });
  const inheritedStation =
    (category as any)?.kdsStation ??
    (typeof (input as any).station === 'string'
      ? String((input as any).station).toUpperCase()
      : 'KITCHEN');
  const data = {
    name: input.name.trim(),
    categoryId: Number(input.categoryId),
    price: Number(input.price),
    vatRate: Number(
      (input as any).vatRate ?? process.env.VAT_RATE_DEFAULT ?? 0.2,
    ),
    active: (input as any).active ?? true,
    isKg: (input as any).isKg ?? false,
    station: inheritedStation,
    ...(typeof input.stockLevel === 'string'
      ? { stockLevel: normalizeMenuStockLevel(input.stockLevel) }
      : {}),
  };
  // Retry a couple of times in case a concurrent create grabbed the SKU
  // between the availability check and the insert.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const sku = await nextAvailableSku(String(input.sku || input.name).trim());
    try {
      const created = await prisma.menuItem.create({
        data: { ...data, sku } as any,
      });
      return { id: created.id, sku: created.sku };
    } catch (e: any) {
      // P2002 = unique constraint violation; retry with a fresh SKU.
      if (e?.code === 'P2002') {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error('Failed to create menu item');
});

ipcMain.handle('menu:updateItem', async (_e, payload) => {
  const input = UpdateMenuItemInputSchema.parse(payload);
  await expireStaleMenuStock(prisma);

  const existing = await prisma.menuItem.findUnique({
    where: { id: input.id },
  });
  if (!existing) throw new Error('Menu item not found');

  const today = localCalendarDateKey();
  const curLevel = normalizeMenuStockLevel((existing as any)?.stockLevel);

  const data: Record<string, unknown> = {
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
  };

  const stockRemainingIn = (input as any).stockRemaining as
    | number
    | null
    | undefined;
  const stockLevelIn =
    typeof input.stockLevel === 'string'
      ? normalizeMenuStockLevel(input.stockLevel)
      : undefined;

  const touchesQtyOnly =
    stockLevelIn === undefined &&
    stockRemainingIn !== undefined &&
    curLevel === 'LOW';

  if (stockLevelIn !== undefined || touchesQtyOnly) {
    const nextLevel = stockLevelIn ?? curLevel;

    if (nextLevel === 'OK') {
      data.stockLevel = 'OK';
      data.stockRemaining = null;
      data.stockDay = null;
    } else if (nextLevel === 'OUT') {
      data.stockLevel = 'OUT';
      data.stockRemaining = null;
      data.stockDay = today;
    } else {
      let rem: number | null = null;
      if (stockRemainingIn !== undefined && stockRemainingIn !== null) {
        rem = Math.floor(Number(stockRemainingIn));
      } else if (existing.stockRemaining != null) {
        rem = existing.stockRemaining;
      }
      if (rem == null || rem < 1) {
        throw new Error(
          'Low stock requires “how many left” as a whole number ≥ 1.',
        );
      }
      data.stockLevel = 'LOW';
      data.stockRemaining = rem;
      data.stockDay = today;
    }
  }

  await prisma.menuItem.update({
    where: { id: input.id },
    data: data as any,
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
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
  const todayEnd = new Date(new Date().setHours(23, 59, 59, 999));
  const settings = await readSettings().catch(() => ({}));
  const fiscalVatEnabled = isVatEnabledFromSettings(settings);

  const [
    users,
    openShifts,
    openTables,
    lowStock,
    queued,
    menuSync,
    staffSync,
    revenueRows,
    coversRowsToday,
    reservationsToday,
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
        where: { createdAt: { gte: todayStart, lte: todayEnd } },
        // `note` is needed so we can exclude rows that were marked
        // "moved-out" by a table transfer (the destination row carries
        // the items now — see `isTransferredOutNote`).
        select: { itemsJson: true, note: true } as any,
      })
      .catch(() => []),
    // Pull all cover writes that happened today. A waiter may save covers
    // multiple times for the same dining session (e.g. corrected from 4 → 5),
    // so we de-dupe per (area, label) keeping only the most recent write.
    prisma.covers
      .findMany({
        where: { createdAt: { gte: todayStart, lte: todayEnd } },
        select: { area: true, label: true, covers: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      })
      .catch(
        () =>
          [] as {
            area: string;
            label: string;
            covers: number;
            createdAt: Date;
          }[],
      ),
    // Reservations for today's day-summary card on the admin overview.
    // Lightweight query — the table is small and we only need a handful of
    // fields. Cancelled rows are still pulled so we can show them in the
    // status breakdown, but they're excluded from cover totals below.
    prisma.reservation
      .findMany({
        where: { startsAt: { gte: todayStart, lte: todayEnd } },
        select: {
          status: true,
          startsAt: true,
          partySize: true,
          customerName: true,
          area: true,
          tableLabel: true,
        },
        orderBy: { startsAt: 'asc' },
        take: 1000,
      })
      .catch(
        () =>
          [] as {
            status: string;
            startsAt: Date;
            partySize: number;
            customerName: string;
            area: string;
            tableLabel: string | null;
          }[],
      ),
  ]);
  // Skip rows tagged as "moved-out" — their revenue is already counted
  // on the destination table row created by the transfer flow.
  const livingRevenueRows = (revenueRows as any[]).filter(
    (r: any) => !isTransferredOutNote(r?.note),
  );
  const fiscalDefaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  const revenueTodayNet = livingRevenueRows.reduce((s, r) => {
    const { net } = sumTicketLinesNetVat(
      r?.itemsJson,
      fiscalVatEnabled,
      fiscalDefaultVatRate,
    );
    return s + net;
  }, 0);
  const revenueTodayVat = livingRevenueRows.reduce((s, r) => {
    const { vat } = sumTicketLinesNetVat(
      r?.itemsJson,
      fiscalVatEnabled,
      fiscalDefaultVatRate,
    );
    return s + vat;
  }, 0);

  // Sum the latest cover count per (area, label) for today so we report
  // "guests served today" rather than the total number of cover writes.
  const seenTables = new Set<string>();
  let coversToday = 0;
  for (const r of coversRowsToday as {
    area: string;
    label: string;
    covers: number;
  }[]) {
    const k = `${r.area}|${r.label}`;
    if (seenTables.has(k)) continue;
    seenTables.add(k);
    const n = Number(r.covers || 0);
    if (Number.isFinite(n) && n > 0) coversToday += n;
  }

  // Reservations day-summary: derive everything off the single small query
  // above so we don't fan out into multiple DB roundtrips.
  type ResRow = {
    status: string;
    startsAt: Date;
    partySize: number;
    customerName: string;
    area: string;
    tableLabel: string | null;
  };
  const resRows = reservationsToday as ResRow[];
  const reservationsByStatusToday: Record<string, number> = {
    BOOKED: 0,
    SEATED: 0,
    COMPLETED: 0,
    NO_SHOW: 0,
    CANCELLED: 0,
  };
  let reservationsCoversToday = 0;
  let reservationsCountedForCovers = 0;
  let upcomingCount = 0;
  let arrivedCount = 0; // reservations whose start time has passed today
  let noShowCount = 0;
  const nowMs = Date.now();
  let nextBooked: ResRow | null = null;
  for (const r of resRows) {
    const status = String(r.status || 'BOOKED').toUpperCase();
    if (
      Object.prototype.hasOwnProperty.call(reservationsByStatusToday, status)
    ) {
      reservationsByStatusToday[status] += 1;
    }
    // Cancelled bookings shouldn't inflate covers/avg-party.
    if (status !== 'CANCELLED') {
      const p = Number(r.partySize || 0);
      if (Number.isFinite(p) && p > 0) {
        reservationsCoversToday += p;
        reservationsCountedForCovers += 1;
      }
    }
    const tMs = new Date(r.startsAt).getTime();
    if (Number.isFinite(tMs)) {
      if (status === 'BOOKED' && tMs > nowMs) {
        upcomingCount += 1;
        if (!nextBooked || tMs < new Date(nextBooked.startsAt).getTime()) {
          nextBooked = r;
        }
      }
      // No-show rate denominator: reservations whose time has already passed
      // (BOOKED/SEATED/COMPLETED/NO_SHOW). Cancelled is excluded — it's not a
      // service event.
      if (
        tMs <= nowMs &&
        (status === 'BOOKED' ||
          status === 'SEATED' ||
          status === 'COMPLETED' ||
          status === 'NO_SHOW')
      ) {
        arrivedCount += 1;
        if (status === 'NO_SHOW') noShowCount += 1;
      }
    }
  }
  const reservationsAvgPartyToday =
    reservationsCountedForCovers > 0
      ? Math.round(
          (reservationsCoversToday / reservationsCountedForCovers) * 10,
        ) / 10
      : 0;
  const reservationsNoShowRateToday =
    arrivedCount > 0 ? Math.round((noShowCount / arrivedCount) * 100) : 0;

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
    fiscalEnabled: fiscalVatEnabled,
    coversToday,
    reservationsTotalToday: resRows.length,
    reservationsCoversToday,
    reservationsAvgPartyToday,
    reservationsByStatusToday,
    reservationsUpcomingToday: upcomingCount,
    reservationsNoShowRateToday,
    nextReservationToday: nextBooked
      ? {
          timeIso: new Date(nextBooked.startsAt).toISOString(),
          customerName: String(nextBooked.customerName || ''),
          partySize: Number(nextBooked.partySize || 0),
          area: String(nextBooked.area || ''),
          tableLabel: nextBooked.tableLabel ?? null,
        }
      : null,
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

ipcMain.handle('reservations:openWindow', async () => {
  createReservationWindow();
  return true;
});

// Reservations
//
// Authorization, validation, conflict-detection, and DTO mapping all live in
// `services/reservations.ts` so the LAN HTTP API (used by mobile clients) and
// the desktop IPC layer share the exact same behaviour.
ipcMain.handle('reservations:list', async (_e, input) => {
  return reservationsService.listReservationsForDay(input || {});
});

ipcMain.handle('reservations:listCounts', async (_e, input) => {
  return reservationsService.listReservationCounts(input || {});
});

ipcMain.handle('reservations:create', async (_e, input) => {
  return reservationsService.createReservation(input || {});
});

ipcMain.handle('reservations:update', async (_e, input) => {
  return reservationsService.updateReservation(input || {});
});

ipcMain.handle('reservations:setStatus', async (_e, input) => {
  return reservationsService.setReservationStatus(input || {});
});

ipcMain.handle('reservations:delete', async (_e, input) => {
  return reservationsService.deleteReservation(input || {});
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
  const filePath = safeName
    ? join(dir, safeName.endsWith('.db') ? safeName : `${safeName}.db`)
    : null;
  let toUpload = filePath && fs.existsSync(filePath) ? filePath : null;
  if (!toUpload) {
    const created = await createDbBackupNow();
    if (!created.ok || !created.file)
      return { ok: false, error: created.error || 'Backup failed' };
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

async function getEnabledStations(): Promise<string[]> {
  try {
    const settings: any = await readSettings();
    return Array.from(enabledStationsFromSettings(settings));
  } catch {
    return [...ALL_KDS_STATIONS];
  }
}

async function createKdsTicketFromLog(input: {
  userId: number;
  area: string;
  tableLabel: string;
  items: any[];
  fireItems?: any[];
  note?: string | null;
}) {
  const okSchema = await ensureKdsLocalSchema();
  if (!okSchema) return null;
  const enabled = new Set(await getEnabledStations());

  const rawLines = Array.isArray(input.fireItems)
    ? input.fireItems
    : Array.isArray(input.items)
      ? input.items
      : [];
  if (rawLines.length === 0) return null;

  const lines = rawLines;
  const routing = await loadKdsRoutingFromDb(prisma).catch(() => ({
    categoryIdToKdsStation: {},
    skuToKdsStation: {},
  }));

  const decorated = decorateKdsTicketItemsFromCategory(lines, routing);

  const usedStations = kdsStationsWithActiveItems(decorated, enabled);
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

    const existingTicket = await tx.kdsTicket.findFirst({
      where: {
        orderId: order.id,
        stations: { some: { status: 'NEW' } },
      },
      orderBy: { id: 'desc' },
    });

    if (existingTicket) {
      const prev = Array.isArray(existingTicket.itemsJson)
        ? (existingTicket.itemsJson as any[])
        : [];
      const merged = [...prev, ...decorated];
      await tx.kdsTicket.update({
        where: { id: existingTicket.id },
        data: { itemsJson: merged },
      });
      for (const st of usedStations) {
        const row = await tx.kdsTicketStation.findFirst({
          where: { ticketId: existingTicket.id, station: st },
        });
        if (!row) {
          await tx.kdsTicketStation.create({
            data: { ticketId: existingTicket.id, station: st, status: 'NEW' },
          });
        } else if (String(row.status || '').toUpperCase() !== 'NEW') {
          await tx.kdsTicketStation.update({
            where: { id: row.id },
            data: {
              status: 'NEW',
              bumpedAt: null,
              bumpedById: null,
            },
          });
        }
      }
      return { orderNo: order.orderNo, ticketId: existingTicket.id };
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

      const tickets = await tx.kdsTicket.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'asc' },
      });
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

          // Keep the ticket on NEW so voided lines stay visible (struck through) until bumped.
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

    const idempotencyKey = String(
      (payload as any)?.idempotencyKey ?? '',
    ).trim();
    if (idempotencyKey) {
      const existing = await prisma.ticketLog
        .findFirst({ where: { idempotencyKey } as any })
        .catch(() => null);
      if (existing) return { ok: true };
    }

    // Sanitize inputs
    const sanitizedArea = sanitizeString(area, 50);
    const sanitizedTableLabel = sanitizeString(tableLabel, 50);
    const sanitizedNote = note ? sanitizeString(note, 500) : null;
    const sanitizedCovers = covers ? sanitizeNumber(covers, 1, 999, 0) : null;

    // Validate items array
    if (!Array.isArray(items) || items.length === 0) return false;

    // The whole "open ⇒ check ⇒ insert ⇒ KDS" sequence happens under
    // the table lock so it can't interleave with a `tables:setOpen` or a
    // transfer for the same table from another device.
    return await withTableLock(sanitizedArea, sanitizedTableLabel, async () => {
      // Refuse to append to a closed table. Without this guard a stale
      // device could add lines to a table that has already been paid out
      // / voided / handed off — which silently rebuilds the closed
      // session, mis-attributes revenue, and (worst of all) reprints
      // duplicate kitchen tickets.
      const isOpen = await coreServices.isTableOpen(
        sanitizedArea,
        sanitizedTableLabel,
      );
      if (!isOpen) {
        return {
          ok: false,
          error: `Table ${sanitizedArea} ${sanitizedTableLabel} is closed`,
          code: 'TABLE_CLOSED',
        };
      }

      // Anti-collision: if the latest log row IN THIS OPEN SESSION was
      // written by a different waiter (and the actor isn't an admin),
      // the actor is operating on a stale view — most likely both
      // waiters tried to claim the same empty table, or this device
      // missed a transfer broadcast. Reject so the renderer can refresh
      // and toast a clear message instead of silently overwriting the
      // session owner.
      //
      // CRITICAL: scope the lookup to the CURRENT open session via
      // `getCurrentSessionOwnerId`. Tables get reused — without that
      // scope, the first send by a fresh waiter who opened a
      // previously-paid-out table would be rejected because the
      // all-time "latest" row belongs to whoever last owned that
      // table label (often days ago).
      const ownerId = await getCurrentSessionOwnerId(
        sanitizedArea,
        sanitizedTableLabel,
      );
      if (ownerId !== null && ownerId !== Number(userId)) {
        const actor = await prisma.user
          .findUnique({ where: { id: Number(userId) } })
          .catch(() => null);
        const actorIsAdmin =
          actor && String((actor as any).role || '').toUpperCase() === 'ADMIN';
        if (!actorIsAdmin) {
          const ownerName = await prisma.user
            .findUnique({ where: { id: ownerId } })
            .catch(() => null);
          return {
            ok: false,
            error: `Table is owned by ${ownerName?.displayName || `waiter #${ownerId}`}`,
            code: 'TABLE_OWNED_BY_OTHER',
            ownerId,
            ownerName: ownerName?.displayName || null,
          };
        }
      }

      // Local-first: always use local DB for tickets
      const stockConsumeLines = Array.isArray(
        (payload as any)?.stockConsumeLines,
      )
        ? ((payload as any).stockConsumeLines as {
            sku?: string;
            qty?: number;
          }[])
        : [];
      const kdsFireItems = Array.isArray((payload as any)?.kdsFireItems)
        ? ((payload as any).kdsFireItems as any[])
        : undefined;

      try {
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await expireStaleMenuStock(tx);
          await tx.ticketLog.create({
            data: {
              userId: Number(userId),
              area: sanitizedArea,
              tableLabel: sanitizedTableLabel,
              covers: sanitizedCovers,
              itemsJson: items ?? [],
              note: sanitizedNote,
              ...(idempotencyKey ? { idempotencyKey } : {}),
            },
          });
          await consumeMenuStockForTicketLines(tx, stockConsumeLines);
        });
      } catch (e: any) {
        if (e?.code === 'P2002' && idempotencyKey) return { ok: true };
        throw e;
      }

      // Notify every other client so the table's waiter badge / metrics
      // refresh in real time. Without this, a table that waiter B
      // already had open keeps showing B's initials on every other
      // device when waiter A appends an item — the open-set didn't
      // change so the badge `useEffect` would not re-fetch.
      try {
        broadcastTicketsChanged({
          area: sanitizedArea,
          tableLabel: sanitizedTableLabel,
          userId: Number(userId),
        });
      } catch {
        // ignore — broadcasting is best-effort
      }

      // KDS: create station-specific ticket rows (best-effort; does not
      // block sending).
      try {
        await createKdsTicketFromLog({
          userId: Number(userId),
          area: sanitizedArea,
          tableLabel: sanitizedTableLabel,
          items: items ?? [],
          fireItems: kdsFireItems,
          note: sanitizedNote,
        });
      } catch (e: any) {
        __kdsLastError = String(
          e?.message || e || 'Failed to create KDS ticket',
        );
        console.error('KDS create ticket failed', e);
        captureException(e instanceof Error ? e : new Error(String(e)), {
          context: 'tickets:log:KDS',
        });
      }
      return { ok: true };
    });
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
  // Scope to the current open session via `tables:openAt`. Tables get
  // reused — without this scope, opening a table that was paid out
  // earlier flashes the previous owner's items in the ticket panel
  // until the next round-trip refresh, which looks broken (and was
  // the source of the "shows the wrong order right after Send" bug).
  // Falling back to the all-time latest only when there's no openAt
  // entry preserves behaviour for callers that intentionally inspect
  // historical state (e.g. tooltip code paths that pre-date sessions).
  const atRow = await prisma.syncState
    .findUnique({ where: { key: 'tables:openAt' } })
    .catch(() => null);
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const sinceIso = atMap[`${area}:${tableLabel}`];
  const sinceParsed = sinceIso ? new Date(sinceIso) : null;
  const since =
    sinceParsed && Number.isFinite(sinceParsed.getTime()) ? sinceParsed : null;
  const where: any = { area, tableLabel };
  if (since) where.createdAt = { gte: since };
  const last = await prisma.ticketLog.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
  });
  if (!last) return null;
  const items = Array.isArray(last.itemsJson) ? (last.itemsJson as any[]) : [];
  return {
    items: items as any,
    note: stripTransferTagsFromNote(last.note) || null,
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

/**
 * KITCHEN always runs the two-stage cook → pass (cooker) flow — it's the
 * product default and no longer configurable. The per-screen "cooker" role
 * (which device is the cook vs the main pickup screen) is still chosen locally.
 */
async function getCookerEnabled(): Promise<boolean> {
  return true;
}

// KDS: list tickets by station + status (NEW/DONE)
ipcMain.handle('kds:listTickets', async (_e, input) => {
  const station = String((input as any)?.station || 'KITCHEN').toUpperCase();
  const status = String((input as any)?.status || 'NEW').toUpperCase();
  const cooker = Boolean((input as any)?.cooker);
  const limit = Math.min(
    200,
    Math.max(1, Number((input as any)?.limit || 100)),
  );
  // IMPORTANT: KDS is always local (even when POS is in cloud mode).

  await ensureKdsLocalSchema();
  try {
    const cookerEnabled = await getCookerEnabled();
    // The cooker screen always reads OPEN (NEW) tickets — its "Done" tab shows
    // cooked-but-not-picked-up lines that still live on open tickets.
    const cookerView = cooker && isTwoStageKitchen(station, cookerEnabled);
    const queryStatus = cookerView ? 'NEW' : status;
    const rows = await (prisma as any).kdsTicketStation.findMany({
      where: kdsStationListWhere(station, queryStatus),
      include: { ticket: { include: { order: true } } },
      orderBy:
        queryStatus === 'NEW'
          ? { ticket: { firedAt: 'asc' } }
          : { bumpedAt: 'desc' },
      take: limit,
    });

    return await formatKdsTicketListRows(rows, station, status, {
      cooker,
      cookerEnabled,
    });
  } catch {
    return [];
  }
});

ipcMain.handle('kds:getTicketDetail', async (_e, input) => {
  await ensureKdsLocalSchema();
  const ticketId = Number((input as any)?.ticketId || 0);
  if (!ticketId) return null;
  try {
    return await getKdsTicketDetail(ticketId);
  } catch {
    return null;
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
  const cooker = Boolean((input as any)?.cooker);
  const bumpedById = Number((input as any)?.userId || 0) || null;
  if (!ticketId) return false;
  // IMPORTANT: KDS is always local (even when POS is in cloud mode).

  await ensureKdsLocalSchema();
  try {
    const now = new Date();
    const bumpedAt = now.toISOString();
    const cookerEnabled = await getCookerEnabled();
    const twoStage = isTwoStageKitchen(station, cookerEnabled);
    const ticket = await (prisma as any).kdsTicket
      .findUnique({ where: { id: ticketId } })
      .catch(() => null);

    // Two-stage KITCHEN: the cooker screen only flags items `cookerBumped`
    // (stage 1) and never completes the station; the main screen finalises
    // just the cooked lines (stage 2).
    if (twoStage && ticket) {
      const itemsAll: any[] = Array.isArray(ticket.itemsJson)
        ? ticket.itemsJson
        : [];
      if (cooker) {
        const nextItems = cookerBumpAllKitchenItems(itemsAll, bumpedAt);
        await (prisma as any).kdsTicket.update({
          where: { id: ticketId },
          data: { itemsJson: nextItems },
        });
        return true;
      }
      const nextItems = bumpReadyKitchenItems(itemsAll, bumpedAt);
      await (prisma as any).kdsTicket.update({
        where: { id: ticketId },
        data: { itemsJson: nextItems },
      });
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
    }

    if (ticket) {
      const itemsAll: any[] = Array.isArray(ticket.itemsJson)
        ? ticket.itemsJson
        : [];
      const nextItems = bumpAllStationItemsInJson(itemsAll, station, bumpedAt);
      await (prisma as any).kdsTicket.update({
        where: { id: ticketId },
        data: { itemsJson: nextItems },
      });
    }
    const updated = await (prisma as any).kdsTicketStation.updateMany({
      where: { ticketId, station, status: 'NEW' },
      data: {
        status: 'DONE',
        bumpedAt: now,
        ...(bumpedById ? { bumpedById } : {}),
      },
    });
    return Boolean(updated?.count);
  } catch {
    return false;
  }
});

ipcMain.handle('kds:recall', async (_e, input) => {
  await ensureKdsLocalSchema();
  return recallKdsTicket(prisma, {
    station: String((input as any)?.station || 'KITCHEN'),
    ticketId: (input as any)?.ticketId,
    itemIdx: (input as any)?.itemIdx,
  });
});

ipcMain.handle('kds:clearDone', async (_e, input) => {
  await ensureKdsLocalSchema();
  return purgeKdsDoneTicketsForStation(
    prisma,
    String((input as any)?.station || 'KITCHEN'),
  );
});

// KDS: read/set the POS-host "cooker" (two-stage kitchen) master switch.
ipcMain.handle('kds:getCookerMode', async () => {
  return { enabled: await getCookerEnabled() };
});

ipcMain.handle('kds:getEnabledStations', async () => {
  try {
    return { stations: await getEnabledStations() };
  } catch {
    return { stations: [...ALL_KDS_STATIONS] };
  }
});

ipcMain.handle('kds:setCookerMode', async (_e, input) => {
  const enabled = Boolean((input as any)?.enabled);
  try {
    await coreServices.updateSettings({
      kds: { cookerEnabled: enabled },
    } as any);
    return { ok: true, enabled };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Failed to set cooker mode' };
  }
});

ipcMain.handle('kds:bumpItem', async (_e, input) => {
  const station = String((input as any)?.station || 'KITCHEN').toUpperCase();
  const ticketId = Number((input as any)?.ticketId || 0);
  const itemIdx = Number((input as any)?.itemIdx ?? -1);
  const cooker = Boolean((input as any)?.cooker);
  const bumpedById = Number((input as any)?.userId || 0) || null;
  if (!ticketId || !Number.isFinite(itemIdx) || itemIdx < 0) return false;
  await ensureKdsLocalSchema();
  const now = new Date();
  try {
    const cookerEnabled = await getCookerEnabled();
    const twoStage = isTwoStageKitchen(station, cookerEnabled);
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

    // Two-stage KITCHEN: the cooker screen flags `cookerBumped` (stage 1); the
    // main screen is blocked from finalising a line the cook hasn't finished.
    if (twoStage && cooker) {
      if (it?.cookerBumped) return true;
      const nextItems = cookerBumpSingleKitchenItem(
        itemsAll,
        itemIdx,
        now.toISOString(),
      );
      await (prisma as any).kdsTicket.update({
        where: { id: ticketId },
        data: { itemsJson: nextItems },
      });
      return true;
    }
    if (twoStage && !cooker && !it?.cookerBumped) {
      // Locked: the cook must bump it first.
      return false;
    }

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
  let actorIsAdmin = false;
  try {
    const settings: any = await readSettings();
    const requireApproval =
      settings?.security?.approvals?.requireManagerPinForVoid !== false;
    const actor = await prisma.user
      .findUnique({ where: { id: userId } })
      .catch(() => null);
    actorIsAdmin =
      (actor && String((actor as any)?.role || '').toUpperCase() === 'ADMIN') ||
      (!actor && actorRoleHint.toUpperCase() === 'ADMIN');
    if (requireApproval && !actorIsAdmin) {
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
  } catch {
    // Fail closed when approvals are on by default.
    return false;
  }

  // Ownership guard: a non-admin waiter can only void on a table they
  // currently own (i.e. their userId matches the latest ticket-log row).
  // Without this, a stale device could void another waiter's items
  // after the table was transferred away — there's no money loss but
  // it corrupts attribution and bypasses the manager-approval audit
  // trail. Admin PIN approval still works as the override path.
  if (!actorIsAdmin && !approvedByAdminId) {
    // Scope to the current session — see `getCurrentSessionOwnerId`.
    const ownerId = await getCurrentSessionOwnerId(area, tableLabel);
    if (ownerId !== null && ownerId !== Number(userId)) {
      return false;
    }
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
  let actorIsAdmin = false;
  try {
    const settings: any = await readSettings();
    const requireApproval =
      settings?.security?.approvals?.requireManagerPinForVoid !== false;
    const actor = await prisma.user
      .findUnique({ where: { id: userId } })
      .catch(() => null);
    actorIsAdmin =
      (actor && String((actor as any)?.role || '').toUpperCase() === 'ADMIN') ||
      (!actor && actorRoleHint.toUpperCase() === 'ADMIN');
    if (requireApproval && !actorIsAdmin) {
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
  } catch {
    return false;
  }

  // Ownership guard — same rule as `tickets:voidItem`. Stops a stale
  // device from wiping out a table that's been transferred away.
  // Scoped to the current session via `getCurrentSessionOwnerId`.
  if (!actorIsAdmin && !approvedByAdminId) {
    const ownerId = await getCurrentSessionOwnerId(area, tableLabel);
    if (ownerId !== null && ownerId !== Number(userId)) {
      return false;
    }
  }
  // Local-first: close table locally. Wrap in `withTableLock` so the
  // close serializes against any in-flight `tickets:log` for the same
  // table — without that, a stale send could slip in between our
  // ownership check and the close, leaving a fresh row on a table the
  // server thinks is voided/closed.
  try {
    await withTableLock(area, tableLabel, async () => {
      await coreServices.setTableOpen(area, tableLabel, false);
    });
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
  // Close table in local open map + openAt so it becomes FREE immediately.
  // Same lock rationale as the other void path: keep the open-map flip
  // and the openAt cleanup atomic with respect to concurrent sends.
  try {
    await withTableLock(area, tableLabel, async () => {
      await coreServices.setTableOpen(area, tableLabel, false);
      const keyAt = 'tables:openAt';
      const atRow = await prisma.syncState.findUnique({
        where: { key: keyAt },
      });
      const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
      delete atMap[`${area}:${tableLabel}`];
      await prisma.syncState.upsert({
        where: { key: keyAt },
        create: { key: keyAt, valueJson: atMap },
        update: { valueJson: atMap },
      });
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
  const settings = await readSettings().catch(() => ({}));
  const defaultVatEnabled = isVatEnabledFromSettings(settings);
  const where: any = { userId };
  if (input?.startIso || input?.endIso) {
    where.createdAt = {};
    if (input?.startIso) where.createdAt.gte = new Date(input.startIso);
    if (input?.endIso) where.createdAt.lte = new Date(input.endIso);
  }
  const limit = Math.min(2000, Math.max(1, Number(input?.limit || 500)));
  const rows = await prisma.ticketLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Admin ticket list: hide source-session rows superseded by a table
  // move. Those rows still exist for audit/reports but would show as a
  // duplicate card next to the destination row (same items, two cards).
  const visibleRows = (rows as any[]).filter(
    (r: any) => !isTransferredOutNote(r?.note),
  );

  // Status resolution per ticket-log row:
  //   VOIDED  -> note explicitly contains "VOIDED" OR every item on the row is voided
  //   ACTIVE  -> the (area, tableLabel) is currently in the `tables:open` map
  //              AND no payment receipt has been printed for it at/after this row's time
  //   PAID    -> otherwise (closed table without a void marker = it was paid out)
  //
  // We resolve PAID by looking up RECEIPT print jobs whose payload meta.kind === 'PAYMENT'.
  // To avoid N+1, fetch once for the unique tables on screen and bucket the
  // earliest payment timestamp per table, then compare per row.
  const uniqueTables = Array.from(
    new Set(
      (visibleRows as any[]).map((r: any) => `${r.area}|${r.tableLabel}`),
    ),
  );
  const openRow = await prisma.syncState
    .findUnique({ where: { key: 'tables:open' } })
    .catch(() => null);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<
    string,
    boolean
  >;

  // Pull recent receipt print jobs and index PAYMENT timestamps per table.
  // 1000 is a generous cap — a single day rarely produces more than a few hundred receipts.
  const paymentsByTable = new Map<
    string,
    { atMs: number; vatEnabled: boolean }[]
  >();
  if (uniqueTables.length) {
    // Same retry-row caveat as `listMyPaidTickets`: only consider
    // original payment-audit rows (`attempts = 0`), never the per-tick
    // re-print rows persisted by `enqueuePrintRetry` when the printer
    // is offline.
    const receiptJobs = await prisma.printJob
      .findMany({
        where: { type: 'RECEIPT' as any, attempts: 0 } as any,
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { createdAt: true, payloadJson: true, attempts: true } as any,
      })
      .catch(() => [] as { createdAt: Date; payloadJson: any }[]);
    for (const j of receiptJobs as {
      createdAt: Date;
      payloadJson: any;
      attempts?: number;
    }[]) {
      if (Number(j?.attempts || 0) > 0) continue;
      const p = (j.payloadJson as any) || {};
      const meta = (p?.meta as any) || {};
      if (String(meta?.kind || '') !== 'PAYMENT') continue;
      const k = `${String(p.area || '')}|${String(p.tableLabel || '')}`;
      if (!uniqueTables.includes(k)) continue;
      const arr = paymentsByTable.get(k) || [];
      arr.push({
        atMs: new Date(j.createdAt).getTime(),
        vatEnabled: resolveVatEnabledFromMeta(meta, settings),
      });
      paymentsByTable.set(k, arr);
    }
    for (const [, arr] of paymentsByTable) arr.sort((a, b) => a.atMs - b.atMs);
  }

  return visibleRows.map((r: any) => {
    const items = Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [];
    const liveItems = items.filter((it: any) => !it?.voided);
    const noteStr = String(r.note || '').toUpperCase();
    const allVoided =
      items.length > 0 && items.every((it: any) => it?.voided === true);
    const isVoided = allVoided || /\bVOIDED\b/.test(noteStr);
    // A row whose note carries the moved-out marker is a snapshot of a
    // session that ended by being transferred elsewhere; the
    // destination row in the same period already represents the
    // payment. Marking it `TRANSFERRED` keeps the audit trail visible
    // without double-counting it as PAID.
    const isTransferredOut = isTransferredOutNote(r.note);

    const tKey = `${r.area}|${r.tableLabel}`;
    const rowMs = new Date(r.createdAt).getTime();
    const payments = paymentsByTable.get(tKey) || [];
    // A payment "covers" this row only if it happened at or after the row was sent.
    const coveringPayment = payments.find((p) => p.atMs >= rowMs);
    const isPaid = Boolean(coveringPayment);
    const rowVatEnabled = coveringPayment
      ? coveringPayment.vatEnabled
      : defaultVatEnabled;
    const isOpen = Boolean(openMap[`${r.area}:${r.tableLabel}`]);

    const status: 'PAID' | 'VOIDED' | 'ACTIVE' | 'TRANSFERRED' = isVoided
      ? 'VOIDED'
      : isTransferredOut
        ? 'TRANSFERRED'
        : isPaid
          ? 'PAID'
          : isOpen
            ? 'ACTIVE'
            : 'PAID';

    // Surface the structured transfer tag so the admin UI can show a
    // "Transferred from X" badge without re-parsing strings on the renderer.
    const parsedTransfer = parseTransferTag(r.note);
    const transfer = parsedTransfer
      ? {
          kind: parsedTransfer.kind,
          fromUserId: parsedTransfer.fromUserId,
          fromUserName: parsedTransfer.fromUserName,
          fromArea: parsedTransfer.fromArea ?? null,
          fromLabel: parsedTransfer.fromLabel ?? null,
          toUserId: parsedTransfer.toUserId ?? null,
          toUserName: parsedTransfer.toUserName ?? null,
          byUserId: parsedTransfer.byUserId,
          byUserName: parsedTransfer.byUserName,
        }
      : null;

    return {
      id: r.id,
      area: r.area,
      tableLabel: r.tableLabel,
      covers: r.covers,
      createdAt: r.createdAt.toISOString(),
      items,
      note: r.note,
      status,
      transfer,
      ...(() => {
        const { net, vat } = sumTicketLinesNetVat(
          liveItems,
          rowVatEnabled,
          Number((settings as any)?.defaultVatRate || 0),
        );
        return { subtotal: net, vat };
      })(),
    };
  });
});

// Notifications IPC
ipcMain.handle('notifications:list', async (_e, input) => {
  const onlyUnread = Boolean(input?.onlyUnread);
  const userId = Number(input?.userId);
  if (!userId) return [];
  const limit = Math.min(500, Math.max(1, Number(input?.limit || 100)));
  const rows = await prisma.notification.findMany({
    where: { userId, ...(onlyUnread ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
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
  // Per-user ticket counts: only the rows that still represent live
  // revenue. Rows whose session was moved to another table carry the
  // `[TRANSFER moved-out ...]` tag and would otherwise inflate the
  // count by 2x (source + destination).
  const liveTicketsWhere = {
    ...where,
    NOT: { note: { contains: '[TRANSFER moved-out' } },
  } as any;
  const logs = await prisma.ticketLog
    .groupBy({
      where: liveTicketsWhere,
      by: ['userId'],
      _count: { userId: true },
    } as any)
    .catch(() => []);
  const users = await prisma.user.findMany({
    where: { role: { not: 'ADMIN' } } as any,
  });

  // Only staff who clocked in during the filtered period (shift overlaps range).
  let clockedInDuringPeriod: Set<number> | null = null;
  if (input?.startIso || input?.endIso) {
    const rangeStart = input?.startIso ? new Date(input.startIso) : new Date(0);
    const rangeEnd = input?.endIso ? new Date(input.endIso) : new Date();
    const periodShifts = await prisma.dayShift
      .findMany({
        where: {
          OR: [
            { closedAt: null, openedAt: { lte: rangeEnd } },
            {
              openedAt: { lte: rangeEnd },
              closedAt: { gte: rangeStart },
            },
          ],
        },
        select: { openedById: true },
      } as any)
      .catch(() => [] as { openedById: number }[]);
    clockedInDuringPeriod = new Set(
      (periodShifts as { openedById: number }[]).map((s) =>
        Number(s.openedById),
      ),
    );
  }

  const openShifts = await prisma.dayShift.findMany({
    where: { closedAt: null },
  });
  const openIds = new Set(openShifts.map((s: any) => s.openedById));
  const counts: Record<number, number> = {};
  for (const r of logs as any[]) counts[r.userId] = r._count.userId;

  // Count transferred-IN tickets per user. We filter in-memory so we
  // can require BOTH "[TRANSFER" (some variant of the tag) AND the
  // absence of the moved-out marker — those are source rows for a
  // transfer that happened ELSEWHERE, not tickets this waiter received.
  const transfersIn: Record<number, number> = {};
  try {
    const transferRows = await prisma.ticketLog
      .findMany({
        where: { ...where, note: { contains: '[TRANSFER' } },
        select: { userId: true, note: true },
      } as any)
      .catch(() => [] as { userId: number; note: string | null }[]);
    for (const row of transferRows as {
      userId: number;
      note: string | null;
    }[]) {
      if (isTransferredOutNote(row.note)) continue;
      transfersIn[row.userId] = (transfersIn[row.userId] ?? 0) + 1;
    }
  } catch {
    // Best-effort metric — never block the list on it.
  }

  const visibleUsers =
    clockedInDuringPeriod == null
      ? users
      : users.filter((u: any) => clockedInDuringPeriod!.has(u.id));

  return visibleUsers.map((u: any) => ({
    id: u.id,
    name: u.displayName,
    active: openIds.has(u.id),
    tickets: counts[u.id] ?? 0,
    transfersIn: transfersIn[u.id] ?? 0,
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
  const limit = Math.min(500, Math.max(1, Number(input?.limit || 100)));
  // Notifications are per-recipient. The admin panel must only show rows
  // addressed to the currently signed-in admin, otherwise it leaks every
  // waiter's personal notification feed (approvals, "your request was
  // approved", etc.) into the admin view.
  const userId = Number(input?.userId || 0);
  if (!userId) return [];
  // Defensive: confirm the caller is actually an active admin in this DB
  // before returning anything. The IPC isn't reachable from non-admin
  // windows in practice, but the cost is one indexed lookup.
  const u = await prisma.user
    .findFirst({ where: { id: userId, active: true } as any })
    .catch(() => null);
  if (!u || String((u as any).role || '').toUpperCase() !== 'ADMIN') return [];

  const rows = await prisma.notification.findMany({
    where: { userId, ...(onlyUnread ? { readAt: null } : {}) },
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

ipcMain.handle('admin:markAllNotificationsRead', async (_e, input) => {
  // Only mark the calling admin's own notifications as read — never wipe
  // every user's unread badge.
  const userId = Number(input?.userId || 0);
  if (!userId) return true;
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
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
    // Pull `note` so transfer-out source rows can be skipped — their
    // items already count on the destination ticket.
    select: { itemsJson: true, note: true } as any,
  });
  const map = new Map<string, { qty: number; revenue: number }>();
  for (const r of rows) {
    if (isTransferredOutNote((r as any).note)) continue;
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
    select: { createdAt: true, itemsJson: true, note: true } as any,
    orderBy: { createdAt: 'asc' },
  });
  const result = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
  for (const r of rows) {
    // Source rows of a table transfer don't represent independent
    // revenue — the destination row in this same bucket already does.
    if (isTransferredOutNote((r as any).note)) continue;
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

// =====================================================================
// Admin Business Review — analytics over arbitrary periods.
// All compute is local-first (no cloud round trip); the local SQLite DB
// already mirrors paid/voided ticket history via TicketLog.
// =====================================================================
ipcMain.handle('admin:getReview', async (_e, input) => {
  const settings = await readSettings().catch(() => ({}));
  const fiscalVatEnabled = isVatEnabledFromSettings(settings);

  type Granularity = 'day' | 'month' | 'year';
  const granularity: Granularity =
    input?.granularity === 'month' || input?.granularity === 'year'
      ? input.granularity
      : 'day';

  const parseRange = (s?: string | null, e?: string | null) => {
    if (!s || !e) return null;
    const start = new Date(s);
    const end = new Date(e);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      return null;
    }
    if (start.getTime() > end.getTime()) return null;
    return { start, end };
  };

  // Fall back to "today" when the caller didn't pass a valid range so the
  // page can still render something useful instead of erroring out.
  const todayRange = (): { start: Date; end: Date } => {
    const s = new Date();
    s.setHours(0, 0, 0, 0);
    const e = new Date();
    e.setHours(23, 59, 59, 999);
    return { start: s, end: e };
  };
  const current =
    parseRange(input?.currentStartIso, input?.currentEndIso) ?? todayRange();
  const curStart = current.start;
  const curEnd = current.end;

  const compare = parseRange(input?.compareStartIso, input?.compareEndIso);

  // Hard cap: don't ever load more than ~2 years of rows in one go.
  const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
  const safeFetchRange = (s: Date, e: Date) => {
    const span = e.getTime() - s.getTime();
    if (span <= TWO_YEARS_MS) return { from: s, to: e, capped: false };
    return { from: new Date(e.getTime() - TWO_YEARS_MS), to: e, capped: true };
  };

  const bucketLabel = (d: Date, g: Granularity): string => {
    if (g === 'year') return String(d.getFullYear());
    if (g === 'month') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    // day
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  };
  const bucketStart = (d: Date, g: Granularity): Date => {
    const out = new Date(d);
    if (g === 'year') {
      out.setMonth(0, 1);
      out.setHours(0, 0, 0, 0);
    } else if (g === 'month') {
      out.setDate(1);
      out.setHours(0, 0, 0, 0);
    } else {
      out.setHours(0, 0, 0, 0);
    }
    return out;
  };
  const nextBucket = (d: Date, g: Granularity): Date => {
    const out = new Date(d);
    if (g === 'year') out.setFullYear(out.getFullYear() + 1);
    else if (g === 'month') out.setMonth(out.getMonth() + 1);
    else out.setDate(out.getDate() + 1);
    return out;
  };

  type AggRow = {
    createdAt: Date;
    userId: number;
    area: string;
    tableLabel: string;
    covers: number | null;
    itemsJson: any;
    note: string | null;
  };

  const fetchRows = async (s: Date, e: Date): Promise<AggRow[]> => {
    const safe = safeFetchRange(s, e);
    // We pull `note` so the aggregation can drop rows tagged as
    // "moved-out" by a table transfer; the destination row inside the
    // same fetch already contributes their revenue, items and covers.
    const rows = (await prisma.ticketLog
      .findMany({
        where: { createdAt: { gte: safe.from, lte: safe.to } },
        select: {
          createdAt: true,
          userId: true,
          area: true,
          tableLabel: true,
          covers: true,
          itemsJson: true,
          note: true,
        } as any,
        orderBy: { createdAt: 'asc' },
      })
      .catch(() => [])) as unknown as AggRow[];
    return rows.filter((r) => !isTransferredOutNote(r?.note));
  };

  const summarize = (
    rows: AggRow[],
    s: Date,
    e: Date,
  ): {
    summary: {
      startIso: string;
      endIso: string;
      revenueNet: number;
      revenueVat: number;
      orders: number;
      items: number;
      covers: number;
      avgTicket: number;
      avgItemsPerTicket: number;
      uniqueTables: number;
      uniqueWaiters: number;
      voidedTickets: number;
    };
    series: {
      label: string;
      bucketIso: string;
      revenue: number;
      orders: number;
    }[];
    waiterAgg: Map<
      number,
      {
        userId: number;
        revenue: number;
        items: number;
        orders: number;
        covers: number;
      }
    >;
    itemAgg: Map<string, { name: string; qty: number; revenue: number }>;
    hourly: { hour: number; orders: number; revenue: number }[];
    weekday: { dayOfWeek: number; orders: number; revenue: number }[];
  } => {
    let revenueNet = 0;
    let revenueVat = 0;
    let items = 0;
    let covers = 0;
    let voidedTickets = 0;
    const tables = new Set<string>();
    const waiters = new Set<number>();
    const waiterAgg = new Map<
      number,
      {
        userId: number;
        revenue: number;
        items: number;
        orders: number;
        covers: number;
      }
    >();
    const itemAgg = new Map<
      string,
      { name: string; qty: number; revenue: number }
    >();

    // Pre-allocate buckets so the chart has a continuous x axis even when
    // some periods are empty.
    const seriesIndex = new Map<string, number>();
    const series: {
      label: string;
      bucketIso: string;
      revenue: number;
      orders: number;
    }[] = [];
    let cursor = bucketStart(s, granularity);
    const cap = nextBucket(bucketStart(e, granularity), granularity);
    let guard = 0;
    while (cursor.getTime() < cap.getTime() && guard < 5000) {
      seriesIndex.set(cursor.toISOString(), series.length);
      series.push({
        label: bucketLabel(cursor, granularity),
        bucketIso: cursor.toISOString(),
        revenue: 0,
        orders: 0,
      });
      cursor = nextBucket(cursor, granularity);
      guard += 1;
    }

    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      orders: 0,
      revenue: 0,
    }));
    const weekday = Array.from({ length: 7 }, (_, d) => ({
      dayOfWeek: d,
      orders: 0,
      revenue: 0,
    }));

    let orders = 0;
    for (const r of rows) {
      const when = new Date(r.createdAt);
      if (when.getTime() < s.getTime() || when.getTime() > e.getTime()) {
        continue;
      }
      const itemsArr = Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [];
      const live = itemsArr.filter((it) => !it?.voided);
      const allVoided = itemsArr.length > 0 && live.length === 0;
      if (allVoided) voidedTickets += 1;

      let rowRevenue = 0;
      let rowVat = 0;
      let rowItems = 0;
      const reviewDefaultVatRate = Number(
        (settings as any)?.defaultVatRate || 0,
      );
      for (const it of live) {
        const qty = Number(it?.qty || 1);
        const unit = Number(it?.unitPrice || 0);
        const lineGross = unit * qty;
        // VAT-inclusive: extract the contained tax so revenueNet is the
        // ex-VAT base and revenueNet + revenueVat == gross sales.
        const rate = effectiveVatRate(it?.vatRate, reviewDefaultVatRate);
        const split = fiscalVatEnabled
          ? splitGrossVat(lineGross, rate)
          : { net: lineGross, vat: 0 };
        rowRevenue += split.net;
        rowVat += split.vat;
        rowItems += qty;
        const name = String(it?.name || 'Item');
        const e2 = itemAgg.get(name) || { name, qty: 0, revenue: 0 };
        e2.qty += qty;
        // Item leaderboard tracks gross sales per item.
        e2.revenue += lineGross;
        itemAgg.set(name, e2);
      }

      revenueNet += rowRevenue;
      revenueVat += rowVat;
      items += rowItems;
      orders += 1;
      const cov = Number(r.covers || 0);
      if (Number.isFinite(cov) && cov > 0) covers += cov;

      tables.add(`${r.area}|${r.tableLabel}`);
      waiters.add(Number(r.userId));
      const wid = Number(r.userId);
      const w = waiterAgg.get(wid) || {
        userId: wid,
        revenue: 0,
        items: 0,
        orders: 0,
        covers: 0,
      };
      w.revenue += rowRevenue;
      w.items += rowItems;
      w.orders += 1;
      w.covers += Number.isFinite(cov) && cov > 0 ? cov : 0;
      waiterAgg.set(wid, w);

      hourly[when.getHours()].orders += 1;
      hourly[when.getHours()].revenue += rowRevenue;
      weekday[when.getDay()].orders += 1;
      weekday[when.getDay()].revenue += rowRevenue;

      const bIso = bucketStart(when, granularity).toISOString();
      const idx = seriesIndex.get(bIso);
      if (idx != null) {
        series[idx].revenue += rowRevenue;
        series[idx].orders += 1;
      }
    }

    return {
      summary: {
        startIso: s.toISOString(),
        endIso: e.toISOString(),
        revenueNet,
        revenueVat,
        orders,
        items,
        covers,
        avgTicket: orders > 0 ? revenueNet / orders : 0,
        avgItemsPerTicket: orders > 0 ? items / orders : 0,
        uniqueTables: tables.size,
        uniqueWaiters: waiters.size,
        voidedTickets,
      },
      series,
      waiterAgg,
      itemAgg,
      hourly,
      weekday,
    };
  };

  const [curRows, cmpRows, allUsers, shifts] = await Promise.all([
    fetchRows(curStart, curEnd),
    compare ? fetchRows(compare.start, compare.end) : Promise.resolve([]),
    prisma.user
      .findMany({
        select: { id: true, displayName: true, role: true, active: true },
      })
      .catch(() => []),
    // Pull shifts that overlap the *current* period to compute hours worked.
    prisma.dayShift
      .findMany({
        where: {
          OR: [
            { closedAt: null, openedAt: { lte: curEnd } },
            {
              openedAt: { lte: curEnd },
              closedAt: { gte: curStart },
            },
          ],
        },
        select: { openedById: true, openedAt: true, closedAt: true },
      })
      .catch(
        () =>
          [] as { openedById: number; openedAt: Date; closedAt: Date | null }[],
      ),
  ]);

  const cur = summarize(curRows, curStart, curEnd);
  const cmp = compare ? summarize(cmpRows, compare.start, compare.end) : null;

  // Hours worked per user, clipped to the current period.
  const hoursByUser = new Map<number, number>();
  for (const sh of shifts as any[]) {
    const opened = new Date(sh.openedAt).getTime();
    const closed = sh.closedAt ? new Date(sh.closedAt).getTime() : Date.now();
    const overlapStart = Math.max(opened, curStart.getTime());
    const overlapEnd = Math.min(closed, curEnd.getTime());
    if (overlapEnd <= overlapStart) continue;
    const hrs = (overlapEnd - overlapStart) / 36e5;
    hoursByUser.set(
      Number(sh.openedById),
      (hoursByUser.get(Number(sh.openedById)) || 0) + hrs,
    );
  }

  const userById = new Map<
    number,
    { displayName: string; role: string; active: boolean }
  >();
  for (const u of allUsers as any[]) {
    userById.set(Number(u.id), {
      displayName: String(u.displayName || `#${u.id}`),
      role: String(u.role || ''),
      active: Boolean(u.active),
    });
  }
  // Include any waiter ids that produced revenue but aren't in the users
  // table (deleted/synced from upstream): show them too instead of dropping.
  const allWaiterIds = new Set<number>([...cur.waiterAgg.keys()]);
  for (const id of allWaiterIds) {
    if (!userById.has(id)) {
      userById.set(id, {
        displayName: `User #${id}`,
        role: 'UNKNOWN',
        active: false,
      });
    }
  }

  const waiters = Array.from(cur.waiterAgg.values())
    .map((w) => {
      const meta = userById.get(w.userId)!;
      const hours = hoursByUser.get(w.userId) || 0;
      return {
        userId: w.userId,
        name: meta.displayName,
        role: meta.role,
        active: meta.active,
        orders: w.orders,
        items: w.items,
        revenue: w.revenue,
        covers: w.covers,
        avgTicket: w.orders > 0 ? w.revenue / w.orders : 0,
        hoursWorked: Math.round(hours * 100) / 100,
        revenuePerHour: hours > 0 ? w.revenue / hours : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const topItems = Array.from(cur.itemAgg.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15);

  return {
    granularity,
    fiscalEnabled: fiscalVatEnabled,
    current: cur.summary,
    compare: cmp?.summary ?? null,
    series: {
      current: cur.series,
      compare: cmp?.series ?? null,
    },
    topItems,
    waiters,
    hourly: cur.hourly,
    weekday: cur.weekday,
  };
});

ipcMain.handle('reports:getMyOverview', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  if (!userId) return { revenueTodayNet: 0, revenueTodayVat: 0, openOrders: 0 };
  const settings = await readSettings().catch(() => ({}));
  const fiscalVatEnabled = isVatEnabledFromSettings(settings);
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date();
  const rows = await prisma.ticketLog
    .findMany({
      where: { userId, createdAt: { gte: start, lte: end } },
      // `note` is required to drop transferred-out source rows so the
      // waiter's "today's revenue" matches what was actually paid.
      select: { itemsJson: true, note: true } as any,
    })
    .catch(() => []);
  const liveRows = (rows as any[]).filter(
    (r: any) => !isTransferredOutNote(r?.note),
  );
  const fiscalDefaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  const revenueTodayNet = liveRows.reduce((s: number, r: any) => {
    const { net } = sumTicketLinesNetVat(
      r?.itemsJson,
      fiscalVatEnabled,
      fiscalDefaultVatRate,
    );
    return s + net;
  }, 0);
  const revenueTodayVat = liveRows.reduce((s: number, r: any) => {
    const { vat } = sumTicketLinesNetVat(
      r?.itemsJson,
      fiscalVatEnabled,
      fiscalDefaultVatRate,
    );
    return s + vat;
  }, 0);
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
  return {
    revenueTodayNet,
    revenueTodayVat,
    openOrders,
    fiscalEnabled: fiscalVatEnabled,
  };
});

ipcMain.handle('reports:getMyTopSellingToday', async (_e, input) => {
  const userId = Number(input?.userId || 0);
  if (!userId) return null;
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date(new Date().setHours(23, 59, 59, 999));
  const rows = await prisma.ticketLog.findMany({
    where: { userId, createdAt: { gte: start, lte: end } },
    select: { itemsJson: true, note: true } as any,
  });
  const map = new Map<string, { qty: number; revenue: number }>();
  for (const r of rows) {
    if (isTransferredOutNote((r as any).note)) continue;
    const items = (r.itemsJson as any[]) || [];
    for (const it of items) {
      if (it?.voided) continue;
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
      select: { createdAt: true, itemsJson: true, note: true } as any,
      orderBy: { createdAt: 'asc' },
    })
    .catch(() => []);
  const result = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
  for (const r of rows as any[]) {
    if (isTransferredOutNote((r as any).note)) continue;
    const when = new Date(r.createdAt);
    const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
    if (idx === -1) continue;
    // Sales trend reports gross sales (total money taken), independent of
    // the VAT split — pass vatEnabled=false so net == gross.
    const net = sumTicketLinesNetVat(r.itemsJson, false).net;
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
  // Scope to the current session via `tables:openAt`, mirroring
  // `tickets:getLatestForTable`. Without this, reopening a label after
  // payout flashes the previous guest count until refresh — the
  // renderer `coversKnown` effect calls into here whenever `isOpen`
  // flips true.
  const sessionStart = await getTableSessionStartedAt(area, label);
  const where: any = { area, label };
  if (sessionStart) where.createdAt = { gte: sessionStart };
  const row = await prisma.covers.findFirst({
    where,
    orderBy: { id: 'desc' },
  });
  return row?.covers ?? null;
});

// Layout persistence via SyncState.
//
// As of the centralised-layout migration, every floor view (waiter,
// host, admin) reads from a single shared key per area:
//   layout:global:<area>
//
// The legacy per-user / per-scope keys are still consulted on read as a
// migration fallback so an existing restaurant doesn't lose its tables
// the first time it boots the new code. The first time the admin saves
// from the new editor, the global key is written and from then on it
// is the authoritative source for all clients.
function globalLayoutKey(area: string): string {
  return `layout:global:${String(area)}`;
}

async function readSharedLayoutNodes(area: string): Promise<any[] | null> {
  if (!area) return null;
  const globalRow = await prisma.syncState
    .findUnique({ where: { key: globalLayoutKey(area) } })
    .catch(() => null);
  const globalNodes = (globalRow?.valueJson as any)?.nodes;
  if (Array.isArray(globalNodes)) return globalNodes;

  // Migration fallback: surface an existing per-user / per-scope layout
  // for this area so admins see what waiters/hosts were already using
  // when they open the editor for the first time. We pick the most
  // recently updated row to favour the freshest layout. The key shape
  // is `layout:<userId>:<area>` (waiter) or `layout:<scope>:<userId>:<area>`
  // (host etc.) — both end with `:<area>` so a prefix scan + suffix
  // filter is enough.
  const candidates = await prisma.syncState
    .findMany({
      where: { key: { startsWith: 'layout:' } as any } as any,
      orderBy: { updatedAt: 'desc' } as any,
    })
    .catch(() => [] as any[]);
  const suffix = `:${area}`;
  for (const row of candidates as any[]) {
    if (typeof row?.key !== 'string') continue;
    if (row.key === globalLayoutKey(area)) continue; // already tried
    if (!row.key.endsWith(suffix)) continue;
    const nodes = (row?.valueJson as any)?.nodes;
    if (Array.isArray(nodes) && nodes.length) return nodes;
  }
  return null;
}

ipcMain.handle('layout:get', async (_e, { area }) => {
  return await readSharedLayoutNodes(String(area || ''));
});

ipcMain.handle('layout:save', async (_e, { area, nodes, userId }) => {
  const a = String(area || '');
  if (!a || !Array.isArray(nodes)) return false;
  // Require the calling user to be an active ADMIN. The shared floor
  // layout is now centrally managed and waiters / hosts must not be
  // able to silently overwrite it via direct IPC. The renderer hides
  // the editor UI from non-admins; this is the second line of defence.
  try {
    const uid = Number(userId || 0);
    if (!uid) return false;
    const u = await prisma.user
      .findUnique({ where: { id: uid } })
      .catch(() => null);
    if (!u || !u.active || String(u.role).toUpperCase() !== 'ADMIN') {
      return false;
    }
  } catch {
    return false;
  }
  await prisma.syncState.upsert({
    where: { key: globalLayoutKey(a) },
    create: { key: globalLayoutKey(a), valueJson: { nodes } },
    update: { valueJson: { nodes } },
  });
  try {
    broadcastLayoutChanged({ area: a });
  } catch {
    // best-effort
  }
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
