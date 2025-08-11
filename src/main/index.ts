import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';
import { LoginWithPinInputSchema, CreateUserInputSchema, UpdateUserInputSchema, SetPrinterInputSchema, SyncMenuFromUrlInputSchema } from '@shared/ipc';
import { setupAutoUpdater } from './updater';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';

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
  if (!ok) return null;
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
  return open.map((s) => s.openedById);
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
  const res = await fetch(url, { headers: { Accept: 'application/json' } as any } as any);
  if (!res.ok) throw new Error(`Failed to fetch staff: ${res.status}`);
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
  const [users, openShifts, openOrders, lowStock, queued, menuSync, staffSync] = await Promise.all([
    prisma.user.count({ where: { active: true } }),
    prisma.dayShift.count({ where: { closedAt: null } }),
    prisma.order.count({ where: { status: 'OPEN' } }).catch(() => 0),
    prisma.inventoryItem.count({ where: { qtyOnHand: { lt: prisma.inventoryItem.fields.lowStockThreshold } } }).catch(() => 0),
    prisma.printJob.count({ where: { status: 'QUEUED' } }).catch(() => 0),
    prisma.syncState.findUnique({ where: { key: 'menu:lastSync' } }).catch(() => null),
    prisma.syncState.findUnique({ where: { key: 'staff:lastSync' } }).catch(() => null),
  ]);
  return {
    activeUsers: users,
    openShifts,
    openOrders,
    lowStockItems: lowStock || 0,
    queuedPrintJobs: queued || 0,
    lastMenuSync: (menuSync as any)?.updatedAt?.toISOString?.() ?? null,
    lastStaffSync: (staffSync as any)?.updatedAt?.toISOString?.() ?? null,
    printerIp: process.env.PRINTER_IP ?? null,
    appVersion: process.env.npm_package_version || '0.1.0',
  };
});

ipcMain.handle('admin:openWindow', async () => {
  createAdminWindow();
  return true;
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


