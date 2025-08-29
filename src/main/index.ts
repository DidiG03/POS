import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';
import { LoginWithPinInputSchema, CreateUserInputSchema, UpdateUserInputSchema, SetPrinterInputSchema, SyncMenuFromUrlInputSchema } from '@shared/ipc';
import { setupAutoUpdater } from './updater';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';
import { startApiServer } from './api';
import { table } from 'node:console';

dotenv.config();

const MAIN_FILE = fileURLToPath(import.meta.url);
const MAIN_DIR = dirname(MAIN_FILE);

let mainWindow: BrowserWindow | null = null;
let adminWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111827',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(MAIN_DIR, '../preload/index.cjs'),
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(MAIN_DIR, '../renderer/index.html'));
  }

  mainWindow.webContents.on('did-fail-load', (_e, ec, ed, vu) => {
    console.error('Renderer failed load', { ec, ed, vu });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
    title: 'Admin - Ullishtja POS',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(MAIN_DIR, '../preload/index.cjs'),
    },
  });
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) adminWindow.loadURL(url + '#/admin');
  else adminWindow.loadFile(join(MAIN_DIR, '../renderer/index.html'), { hash: '/admin' });
  adminWindow.on('closed', () => {
    adminWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
  startApiServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers (skeleton with validation)
ipcMain.handle('auth:loginWithPin', async (_e, payload) => {
  const { pin, userId } = LoginWithPinInputSchema.parse(payload);
  const where: any = userId ? { id: userId, active: true } : { active: true };
  const user = await prisma.user.findFirst({ where });
  if (!user) return null;
  const ok = await bcrypt.compare(pin, user.pinHash);
  if (!ok) {
    // record a security notification for the targeted user
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'SECURITY' as any,
        message: 'Wrong PIN attempt on your account',
      },
    }).catch(() => {});
    return null;
  }
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
  };
});

ipcMain.handle('auth:createUser', async (_e, payload) => {
  const input = CreateUserInputSchema.parse(payload);
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

ipcMain.handle('auth:listUsers', async () => {
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
  const input = UpdateUserInputSchema.parse(payload);
  let pinHash: string | undefined;
  if (input.pin) pinHash = await bcrypt.hash(input.pin, 10);
  const updated = await prisma.user.update({
    where: { id: input.id },
    data: {
      displayName: input.displayName,
      role: input.role,
      active: input.active,
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

// Shifts IPC
ipcMain.handle('shifts:getOpen', async (_e, { userId }) => {
  const open = await prisma.dayShift.findFirst({ where: { closedAt: null, openedById: userId } });
  return open
    ? { id: open.id, openedAt: open.openedAt.toISOString(), closedAt: open.closedAt?.toISOString() ?? null, openedById: open.openedById, closedById: open.closedById ?? null }
    : null;
});

ipcMain.handle('shifts:clockIn', async (_e, { userId }) => {
  const already = await prisma.dayShift.findFirst({ where: { closedAt: null, openedById: userId } });
  if (already) return { id: already.id, openedAt: already.openedAt.toISOString(), closedAt: null, openedById: already.openedById, closedById: already.closedById ?? null };
  const created = await prisma.dayShift.create({ data: { openedById: userId, totalsJson: {} } as any });
  return { id: created.id, openedAt: created.openedAt.toISOString(), closedAt: null, openedById: created.openedById, closedById: created.closedById ?? null };
});

ipcMain.handle('shifts:clockOut', async (_e, { userId }) => {
  const open = await prisma.dayShift.findFirst({ where: { closedAt: null, openedById: userId } });
  if (!open) return null;
  const updated = await prisma.dayShift.update({ where: { id: open.id }, data: { closedAt: new Date(), closedById: userId } });
  return { id: updated.id, openedAt: updated.openedAt.toISOString(), closedAt: updated.closedAt?.toISOString() ?? null, openedById: updated.openedById, closedById: updated.closedById ?? null };
});

ipcMain.handle('shifts:listOpen', async () => {
  const open = await prisma.dayShift.findMany({ where: { closedAt: null } });
  return open.map((s: { openedById: number }) => s.openedById);
});

// Sync staff from external API and upsert into local users
ipcMain.handle('auth:syncStaffFromApi', async (_e, raw) => {
  const url: string = (raw?.url as string) || process.env.STAFF_API_URL || 'https://ullishtja-agroturizem.com/api/staff';
  // Cache: skip network if synced within 10 minutes
  const staffLast = await prisma.syncState.findUnique({ where: { key: 'staff:lastSync' } });
  const staffTs = staffLast?.valueJson ? Number((staffLast.valueJson as any).ts) : 0;
  if (Date.now() - staffTs < 10 * 60 * 1000) {
    const users = await prisma.user.findMany({});
    return users.length;
  }
  let res: any;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } as any } as any);
  } catch {
    return (await prisma.user.count()) || 0; // network failure: silently fallback
  }
  if (!res.ok) {
    // Upstream 5xx: keep existing staff, update lastSync to avoid loops for a short period
    await prisma.syncState.upsert({ where: { key: 'staff:lastSync' }, create: { key: 'staff:lastSync', valueJson: { ts: Date.now() } }, update: { valueJson: { ts: Date.now() } } });
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
    const existing = await prisma.user.findFirst({ where: { externalId: s.id } });
    if (existing) {
      await prisma.user.update({ where: { id: existing.id }, data: { displayName: fullName, pinHash, active: true } });
    } else {
      await prisma.user.create({ data: { displayName: fullName || 'Staff', role: 'WAITER', pinHash, active: true, externalId: s.id } });
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
  const envDefaults = {
    restaurantName: process.env.RESTAURANT_NAME || 'Ullishtja Agroturizem',
    currency: process.env.CURRENCY || 'EUR',
    defaultVatRate: Number(process.env.VAT_RATE_DEFAULT || 0.2),
    printer: {
      ip: process.env.PRINTER_IP,
      port: process.env.PRINTER_PORT ? Number(process.env.PRINTER_PORT) : undefined,
    },
    enableAdmin: process.env.ENABLE_ADMIN === 'true',
    tableCountMainHall: process.env.TABLE_COUNT_MAIN_HALL ? Number(process.env.TABLE_COUNT_MAIN_HALL) : 8,
    tableCountTerrace: process.env.TABLE_COUNT_TERRACE ? Number(process.env.TABLE_COUNT_TERRACE) : 4,
    tableAreas: [
      { name: 'Main Hall', count: process.env.TABLE_COUNT_MAIN_HALL ? Number(process.env.TABLE_COUNT_MAIN_HALL) : 8 },
      { name: 'Terrace', count: process.env.TABLE_COUNT_TERRACE ? Number(process.env.TABLE_COUNT_TERRACE) : 4 },
    ],
  } as any;
  const [row, dbAreas] = await Promise.all([
    prisma.syncState.findUnique({ where: { key: 'settings' } }).catch(() => null),
    prisma.area.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }).catch(() => []),
  ]);
  const stored = (row?.valueJson as any) || {};
  const tableAreas = (dbAreas as any[]).length
    ? (dbAreas as any[]).map((a) => ({ name: a.name, count: a.defaultCount }))
    : stored.tableAreas ?? envDefaults.tableAreas;
  return { ...envDefaults, ...stored, tableAreas };
}

ipcMain.handle('settings:get', async () => {
  return await readSettings();
});

ipcMain.handle('settings:update', async (_e, input) => {
  // Merge and persist in SyncState, so admin changes survive restarts
  const current = await readSettings();
  const merged = { ...current, ...input };
  await prisma.syncState.upsert({
    where: { key: 'settings' },
    create: { key: 'settings', valueJson: merged },
    update: { valueJson: merged },
  });
  // Also reflect table areas into Area table if provided
  if (Array.isArray((input as any).tableAreas)) {
    const areas = (input as any).tableAreas as { name: string; count: number }[];
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
    await prisma.area.updateMany({ where: { name: { notIn: names } }, data: { active: false } });
  }
  return merged;
});

ipcMain.handle('settings:setPrinter', async (_e, payload) => {
  const _ = SetPrinterInputSchema.parse(payload);
  // TODO persist
  return await readSettings();
});

ipcMain.handle('settings:testPrint', async () => {
  try {
    // Basic network ESC/POS test to PRINTER_IP:9100
    const ip = process.env.PRINTER_IP;
    const port = Number(process.env.PRINTER_PORT || 9100);
    if (!ip) throw new Error('PRINTER_IP not set');
    const { Socket } = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      socket.once('error', reject);
      socket.connect(port, ip, () => {
        const ESC = Buffer.from([0x1b]);
        const GS = Buffer.from([0x1d]);
        const data = Buffer.concat([
          ESC, Buffer.from('@'), // init
          Buffer.from('Ullishtja POS Test Print\n'),
          Buffer.from('-------------------------\n'),
          Buffer.from(new Date().toISOString() + '\n\n'),
          GS, Buffer.from('V'), Buffer.from([0x41]), Buffer.from([0x10]), // cut partial
        ]);
        socket.write(data, () => {
          socket.end();
          resolve();
        });
      });
    });
    return true;
  } catch {
    return false;
  }
});

// Persist open tables in SyncState for accurate open order counts
ipcMain.handle('tables:setOpen', async (_e, input) => {
  const area = String(input?.area || '');
  const label = String(input?.label || '');
  const open = Boolean(input?.open);
  if (!area || !label) return false;
  const key = 'tables:open';
  const row = await prisma.syncState.findUnique({ where: { key } });
  const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
  const k = `${area}:${label}`;
  if (open) map[k] = true; else delete map[k];
  await prisma.syncState.upsert({ where: { key }, create: { key, valueJson: map }, update: { valueJson: map } });
  // Track open timestamp for current session
  const keyAt = 'tables:openAt';
  const atRow = await prisma.syncState.findUnique({ where: { key: keyAt } });
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  if (open) atMap[k] = new Date().toISOString(); else delete atMap[k];
  await prisma.syncState.upsert({ where: { key: keyAt }, create: { key: keyAt, valueJson: atMap }, update: { valueJson: atMap } });
  return true;
});

ipcMain.handle('tables:listOpen', async () => {
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

// Menu: fetch from remote and persist locally
ipcMain.handle('menu:syncFromUrl', async (_e, raw) => {
  const input = SyncMenuFromUrlInputSchema.parse(raw);
  const url = input.url || process.env.MENU_API_URL || 'https://ullishtja-agroturizem.com/api/pos-menu?lang=en';
  // Cache: skip network if synced recently
  const last = await prisma.syncState.findUnique({ where: { key: 'menu:lastSync' } });
  const lastTs = last?.valueJson ? Number((last.valueJson as any).ts) : 0;
  if (Date.now() - lastTs < 10 * 60 * 1000) {
    return { categories: 0, items: 0 };
  }
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      'User-Agent': 'UllishtjaPOS/0.1 (+Electron)' as any,
    },
  } as any);
  if (!res.ok) throw new Error(`Failed to fetch menu: ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  let body: any;
  try {
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      const txt = await res.text();
      const start = txt.indexOf('{');
      const end = txt.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        body = JSON.parse(txt.slice(start, end + 1));
      } else {
        throw new Error(`Non-JSON response: ${txt.slice(0, 200)}`);
      }
    }
  } catch (e) {
    throw new Error(`Failed to parse menu JSON: ${String(e).slice(0, 200)}`);
  }
  // API shape observed: { success, source, language, updatedAt, data: Category[] }
  const categories = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.categories)
      ? body.categories
      : Array.isArray(body)
        ? body
        : [];
  let catCount = 0;
  let itemCount = 0;
  for (const cat of categories) {
    const name: string = cat.name ?? 'Uncategorized';
    const sortOrder: number = typeof cat.sortOrder === 'number' ? cat.sortOrder : 0;
    const active: boolean = cat.active !== false;
    const existing = await prisma.category.findFirst({ where: { name } });
    const category = existing
      ? await prisma.category.update({ where: { id: existing.id }, data: { sortOrder, active } })
      : await prisma.category.create({ data: { name, sortOrder, active } });
    catCount += existing ? 0 : 1;
    const items = Array.isArray(cat.items) ? cat.items : [];
    for (const it of items) {
      const sku: string = it.sku ?? it.id ?? `${name}:${it.name}`;
      const price: number = Number(it.price ?? 0);
      const vatRate: number = Number(it.vatRate ?? process.env.VAT_RATE_DEFAULT ?? 0.2);
      const itActive: boolean = it.active !== false;
      const exists = await prisma.menuItem.findUnique({ where: { sku } });
      if (exists) {
        await prisma.menuItem.update({
          where: { sku },
          data: { name: it.name ?? exists.name, price, vatRate, categoryId: category.id, active: itActive },
        });
      } else {
        await prisma.menuItem.create({
          data: { name: it.name ?? 'Item', sku, categoryId: category.id, price, vatRate, active: itActive },
        });
        itemCount += 1;
      }
    }
  }
  await prisma.syncState.upsert({
    where: { key: 'menu:lastSync' },
    create: { key: 'menu:lastSync', valueJson: { ts: Date.now() } },
    update: { valueJson: { ts: Date.now() } },
  });
  return { categories: catCount, items: itemCount };
});

ipcMain.handle('menu:listCategoriesWithItems', async () => {
  const cats = await prisma.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    include: { items: { where: { active: true }, orderBy: { name: 'asc' } } },
  });
  return cats.map((c: any) => ({
    id: c.id,
    name: c.name,
    sortOrder: c.sortOrder,
    active: c.active,
    items: c.items.map((i: any) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      price: Number(i.price),
      vatRate: Number(i.vatRate),
      active: i.active,
      categoryId: i.categoryId,
    })),
  }));
});

// Admin overview
ipcMain.handle('admin:getOverview', async () => {
  const [users, openShifts, openTables, lowStock, queued, menuSync, staffSync, revenueRows] = await Promise.all([
    prisma.user.count({ where: { active: true } }),
    prisma.dayShift.count({ where: { closedAt: null } }),
    (async () => {
      const key = 'tables:open';
      const row = await prisma.syncState.findUnique({ where: { key } }).catch(() => null);
      const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
      return Object.values(map).filter(Boolean).length;
    })(),
    prisma.inventoryItem.count({ where: { qtyOnHand: { lt: prisma.inventoryItem.fields.lowStockThreshold } } }).catch(() => 0),
    prisma.printJob.count({ where: { status: 'QUEUED' } }).catch(() => 0),
    prisma.syncState.findUnique({ where: { key: 'menu:lastSync' } }).catch(() => null),
    prisma.syncState.findUnique({ where: { key: 'staff:lastSync' } }).catch(() => null),
    prisma.ticketLog.findMany({
      where: {
        createdAt: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
          lte: new Date(new Date().setHours(23, 59, 59, 999)),
        },
      },
      select: { itemsJson: true },
    }).catch(() => []),
  ]);
  const revenueTodayNet = (revenueRows as any[]).reduce((s, r) => s + (r.itemsJson as any[]).reduce((ss: number, it: any) => ss + (Number(it.unitPrice) * Number(it.qty || 1)), 0), 0);
  const revenueTodayVat = (revenueRows as any[]).reduce((s, r) => s + (r.itemsJson as any[]).reduce((ss: number, it: any) => ss + (Number(it.unitPrice) * Number(it.qty || 1) * Number(it.vatRate || 0)), 0), 0);
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

// Tickets logging
ipcMain.handle('tickets:log', async (_e, payload) => {
  const { userId, area, tableLabel, covers, items, note } = payload || {};
  if (!userId || !area || !tableLabel) return false;
  await prisma.ticketLog.create({
    data: {
      userId: Number(userId),
      area: String(area),
      tableLabel: String(tableLabel),
      covers: covers ? Number(covers) : null,
      itemsJson: items ?? [],
      note: note ? String(note) : null,
    },
  });
  return true;
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
  return {
    items: last.itemsJson as any,
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
  const openRow = await prisma.syncState.findUnique({ where: { key: 'tables:open' } });
  const openMap = ((openRow?.valueJson as any) || {}) as Record<string, boolean>;
  const k = `${area}:${tableLabel}`;
  if (!openMap[k]) return null;
  // Session start time
  const atRow = await prisma.syncState.findUnique({ where: { key: 'tables:openAt' } });
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const sinceIso = atMap[k];
  const since = sinceIso ? new Date(sinceIso) : null;
  const where: any = { area, tableLabel };
  if (since) where.createdAt = { gte: since };
  const [last, coversRow] = await Promise.all([
    prisma.ticketLog.findFirst({ where, orderBy: { createdAt: 'desc' } }),
    prisma.covers.findFirst({ where: { area, label: tableLabel, ...(since ? { createdAt: { gte: since } as any } : {}) }, orderBy: { id: 'desc' } } as any),
  ]);
  const items = ((last?.itemsJson as any[]) || []).filter((it: any) => !it.voided);
  const total = items.reduce((s: number, it: any) => s + Number(it.unitPrice || 0) * Number(it.qty || 1), 0);
  return {
    covers: coversRow?.covers ?? null,
    firstAt: since ? since.toISOString() : last ? new Date(last.createdAt).toISOString() : null,
    total,
  };
});

// Void item: records a notification and returns true
ipcMain.handle('tickets:voidItem', async (_e, input) => {
  const userId = Number(input?.userId);
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  const item = input?.item as any;
  if (!userId || !area || !tableLabel || !item?.name) return false;
  const message = `Voided item on ${area} ${tableLabel}: ${item.name} x${Number(item.qty || 1)}`;
  await prisma.notification.create({ data: { userId, type: 'OTHER' as any, message } }).catch(() => {});
  // Also append a void marker in the latest ticket log for this table (if exists)
  const last = await prisma.ticketLog.findFirst({ where: { area, tableLabel }, orderBy: { createdAt: 'desc' } });
  if (last) {
    const items = (last.itemsJson as any[]) || [];
    const idx = items.findIndex((it: any) => it.name === item.name);
    if (idx !== -1) {
      items[idx] = { ...items[idx], voided: true };
      await prisma.ticketLog.update({ where: { id: last.id }, data: { itemsJson: items } });
    }
  }
  return true;
});

ipcMain.handle('tickets:voidTicket', async (_e, input) => {
  const userId = Number(input?.userId);
  const area = String(input?.area || '');
  const tableLabel = String(input?.tableLabel || '');
  const reason = String(input?.reason || '');
  if (!userId || !area || !tableLabel) return false;
  const message = `Voided ticket on ${area} ${tableLabel}${reason ? `: ${reason}` : ''}`;
  await prisma.notification.create({ data: { userId, type: 'OTHER' as any, message } }).catch(() => {});
  // Mark all items in the latest ticket as voided for admin view
  const last = await prisma.ticketLog.findFirst({ where: { area, tableLabel }, orderBy: { createdAt: 'desc' } });
  if (last) {
    const items = ((last.itemsJson as any[]) || []).map((it: any) => ({ ...it, voided: true }));
    await prisma.ticketLog.update({ where: { id: last.id }, data: { itemsJson: items, note: last.note ? `${last.note} | VOIDED${reason ? `: ${reason}` : ''}` : `VOIDED${reason ? `: ${reason}` : ''}` } });
  }
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
  const rows = await prisma.ticketLog.findMany({ where, orderBy: { createdAt: 'desc' } });
  return rows.map((r: any) => ({
    id: r.id,
    area: r.area,
    tableLabel: r.tableLabel,
    covers: r.covers,
    createdAt: r.createdAt.toISOString(),
    items: r.itemsJson as any,
    note: r.note,
    subtotal: (r.itemsJson as any[]).reduce((s: number, it: any) => s + (Number(it.unitPrice) * Number(it.qty || 1)), 0),
    vat: (r.itemsJson as any[]).reduce((s: number, it: any) => s + (Number(it.unitPrice) * Number(it.qty || 1) * Number(it.vatRate || 0)), 0),
  }));
});

// Notifications IPC
ipcMain.handle('notifications:list', async (_e, input) => {
  const userId = Number(input?.userId);
  const onlyUnread = Boolean(input?.onlyUnread);
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
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return true;
});

ipcMain.handle('admin:listTicketCounts', async (_e, input) => {
  const where: any = {};
  if (input?.startIso || input?.endIso) {
    where.createdAt = {};
    if (input?.startIso) where.createdAt.gte = new Date(input.startIso);
    if (input?.endIso) where.createdAt.lte = new Date(input.endIso);
  }
  const logs = await prisma.ticketLog.groupBy({ where, by: ['userId'], _count: { userId: true } } as any).catch(() => []);
  const users = await prisma.user.findMany({ where: { role: { not: 'ADMIN' } } as any });
  const openShifts = await prisma.dayShift.findMany({ where: { closedAt: null } });
  const openIds = new Set(openShifts.map((s: any) => s.openedById));
  const counts: Record<number, number> = {};
  for (const r of logs as any[]) counts[r.userId] = r._count.userId;
  return users.map((u: any) => ({ id: u.id, name: u.displayName, active: openIds.has(u.id), tickets: counts[u.id] ?? 0 }));
});

ipcMain.handle('admin:listShifts', async () => {
  const rows = await prisma.dayShift.findMany({
    orderBy: { openedAt: 'desc' },
    include: { openedBy: true, closedBy: true },
  } as any).catch(() => []);
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

ipcMain.handle('admin:markAllNotificationsRead', async () => {
  await prisma.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
  return true;
});

// Top selling item today from TicketLog
ipcMain.handle('admin:getTopSellingToday', async () => {
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date(new Date().setHours(23, 59, 59, 999));
  const rows = await prisma.ticketLog.findMany({ where: { createdAt: { gte: start, lte: end } }, select: { itemsJson: true } });
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
    if (!best || v.qty > best.qty) best = { name, qty: v.qty, revenue: v.revenue };
  }
  return best;
});

// Sales trends (daily/weekly/monthly)
ipcMain.handle('admin:getSalesTrends', async (_e, input) => {
  const range = (input?.range as any) || 'daily';
  const now = new Date();
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
      const week = Math.ceil((((from.getTime() - oneJan.getTime()) / 86400000) + oneJan.getDay() + 1) / 7);
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
    where: { createdAt: { gte: buckets[0].from, lte: buckets[buckets.length - 1].to } },
    select: { createdAt: true, itemsJson: true },
    orderBy: { createdAt: 'asc' },
  });
  const result = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
  for (const r of rows) {
    const when = new Date(r.createdAt);
    const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
    if (idx === -1) continue;
    const net = (r.itemsJson as any[]).reduce((s: number, it: any) => s + (Number(it.unitPrice) * Number(it.qty || 1)), 0);
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
  const row = await prisma.covers.findFirst({ where: { area, label }, orderBy: { id: 'desc' } });
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
  if (!requesterId || !ownerId || !area || !tableLabel || !Array.isArray(items)) return false;

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
  const requester = await prisma.user.findUnique({ where: { id: Number(requesterId) } });
  const msg = `${requester?.displayName || 'Staff'} requested to add items on ${area} ${tableLabel} (Request #${created.id})`;
  await prisma.notification.create({ data: { userId: Number(ownerId), type: 'OTHER' as any, message: msg } }).catch(() => {});
  return true;
});

// List pending requests for owner
ipcMain.handle('requests:listForOwner', async (_e, input) => {
  const ownerId = Number(input?.ownerId);
  if (!ownerId) return [];
  const rows = await prisma.ticketRequest.findMany({ where: { ownerId, status: 'PENDING' as any }, orderBy: { createdAt: 'desc' } } as any);
  return rows.map((r: any) => ({ id: r.id, area: r.area, tableLabel: r.tableLabel, requesterId: r.requesterId, items: r.itemsJson, note: r.note, createdAt: r.createdAt.toISOString() }));
});

// Approve or reject
ipcMain.handle('requests:approve', async (_e, input) => {
  const id = Number(input?.id); const ownerId = Number(input?.ownerId);
  if (!id || !ownerId) return false;
  const r = await prisma.ticketRequest.findUnique({ where: { id } });
  if (!r || r.ownerId !== ownerId || r.status !== ('PENDING' as any)) return false;
  await prisma.ticketRequest.update({ where: { id }, data: { status: 'APPROVED' as any, decidedAt: new Date() } });
  // Persist the approval by appending items to the latest ticket log snapshot
  try {
    const last = await prisma.ticketLog.findFirst({ where: { area: r.area, tableLabel: r.tableLabel }, orderBy: { createdAt: 'desc' } });
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
        map.set(it.name, { ...existing, qty: Number(existing.qty || 0) + Number(it.qty || 1) });
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
  } catch {}
  await prisma.notification.create({ data: { userId: r.requesterId, type: 'OTHER' as any, message: `Your request #${id} on ${r.area} ${r.tableLabel} was approved` } }).catch(() => {});
  return true;
});

ipcMain.handle('requests:reject', async (_e, input) => {
  const id = Number(input?.id); const ownerId = Number(input?.ownerId);
  if (!id || !ownerId) return false;
  const r = await prisma.ticketRequest.findUnique({ where: { id } });
  if (!r || r.ownerId !== ownerId || r.status !== ('PENDING' as any)) return false;
  await prisma.ticketRequest.update({ where: { id }, data: { status: 'REJECTED' as any, decidedAt: new Date() } });
  await prisma.notification.create({ data: { userId: r.requesterId, type: 'OTHER' as any, message: `Your request #${id} on ${r.area} ${r.tableLabel} was rejected` } }).catch(() => {});
  return true;
});

// Owner's OrderPage polls approved requests for current table
ipcMain.handle('requests:pollApprovedForTable', async (_e, input) => {
  const ownerId = Number(input?.ownerId);
  const area = String(input?.area || ''); const tableLabel = String(input?.tableLabel || '');
  if (!ownerId || !area || !tableLabel) return [];
  const rows = await prisma.ticketRequest.findMany({ where: { ownerId, area, tableLabel, status: 'APPROVED' as any }, orderBy: { createdAt: 'asc' } } as any);
  return rows.map((r: any) => ({ id: r.id, items: r.itemsJson, note: r.note }));
});

// Mark applied so we don’t re-apply
ipcMain.handle('requests:markApplied', async (_e, input) => {
  const ids: number[] = Array.isArray(input?.ids) ? input.ids : [];
  if (!ids.length) return false;
  await prisma.ticketRequest.updateMany({ where: { id: { in: ids }, status: 'APPROVED' as any }, data: { status: 'APPLIED' as any, decidedAt: new Date() } } as any);
  return true;
});


