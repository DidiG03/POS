import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';
import { LoginWithPinInputSchema, CreateUserInputSchema, UpdateUserInputSchema, SetPrinterInputSchema } from '@shared/ipc';
import { setupAutoUpdater } from './updater';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';

dotenv.config();

const MAIN_FILE = fileURLToPath(import.meta.url);
const MAIN_DIR = dirname(MAIN_FILE);

let mainWindow: BrowserWindow | null = null;

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
  const { pin } = LoginWithPinInputSchema.parse(payload);
  const user = await prisma.user.findFirst({ where: { active: true } });
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
  return users.map((u) => ({
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

ipcMain.handle('settings:get', async () => {
  return {
    restaurantName: process.env.RESTAURANT_NAME || 'Ullishtja Agroturizem',
    currency: process.env.CURRENCY || 'EUR',
    defaultVatRate: Number(process.env.VAT_RATE_DEFAULT || 0.2),
    printer: {
      ip: process.env.PRINTER_IP,
      port: process.env.PRINTER_PORT ? Number(process.env.PRINTER_PORT) : undefined,
    },
  };
});

ipcMain.handle('settings:update', async (_e, input) => {
  // TODO persist in DB
  return input;
});

ipcMain.handle('settings:setPrinter', async (_e, payload) => {
  const _ = SetPrinterInputSchema.parse(payload);
  // TODO persist
  return await (await ipcMain.invoke('settings:get'));
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


