/**
 * Standalone "OneTap Admin" Electron app.
 *
 * Thin LAN client — no POS database, printer drivers, or Prisma. It talks
 * HTTP to a POS host on the LAN (same model as OneTap KDS) so back-office
 * can run on a separate machine without sharing the till window.
 *
 * Bootstrapping:
 *   1. Read saved host config from `<userData>/admin.config.json`.
 *   2. If configured, load `index.html#/admin` (PIN login).
 *   3. Otherwise, load `#/admin-setup` to discover or type a POS host.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { buildLanHttpUrl } from '@shared/lanHost';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import {
  attachWindowRecovery,
  installOsResumeRecovery,
} from '../services/windowRecovery';
import { initSentry } from '../services/sentry';
import {
  cleanup as cleanupUpdater,
  registerUpdateListener,
  setupAutoUpdater,
  updaterHandlers,
} from '../updater';
import { registerCompanionLanIpc } from '../services/companionLanProxy';

app.setName('OneTap Admin');
initSentry();

const MAIN_FILE = fileURLToPath(import.meta.url);
const MAIN_DIR = dirname(MAIN_FILE);
const MAIN_RUNTIME_DIR =
  basename(MAIN_DIR) === 'chunks' ? resolvePath(MAIN_DIR, '..') : MAIN_DIR;
const PRELOAD_PATH = join(MAIN_RUNTIME_DIR, '../preload/admin.cjs');
const RENDERER_INDEX_HTML = join(MAIN_RUNTIME_DIR, '../../renderer/index.html');

type AdminConfig = {
  host: string;
  httpPort: number;
  httpsPort?: number;
  businessCode?: string;
};

function configPath(): string {
  return join(app.getPath('userData'), 'admin.config.json');
}

function readConfig(): AdminConfig | null {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    const j = JSON.parse(raw);
    if (!j || typeof j.host !== 'string' || !j.host.trim()) return null;
    const httpPort = Number(j.httpPort) || 3333;
    const httpsPort = Number(j.httpsPort) || undefined;
    return {
      host: String(j.host).trim(),
      httpPort,
      httpsPort,
      businessCode: j.businessCode ? String(j.businessCode) : undefined,
    };
  } catch {
    return null;
  }
}

function writeConfig(cfg: AdminConfig): void {
  try {
    fs.mkdirSync(dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    if (typeof console !== 'undefined')
      console.warn('[admin] failed to save config:', e);
    throw e;
  }
}

function clearConfig(): void {
  try {
    const p = configPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

let mainWindow: BrowserWindow | null = null;

function loadHash(
  win: BrowserWindow,
  hash: '/admin' | '/admin-setup',
  opts?: { bustCache?: boolean },
): void {
  const bust = opts?.bustCache ? String(Date.now()) : '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    const origin = devUrl.replace(/#.*$/, '').replace(/\?.*$/, '');
    const q = bust ? `?posHost=${bust}` : '';
    void win.loadURL(`${origin}${q}#${hash}`);
  } else {
    void win.loadFile(RENDERER_INDEX_HTML, {
      hash,
      ...(bust ? { query: { posHost: bust } } : {}),
    });
  }
}

function ensurePackagedDefaults() {
  try {
    if (!app.isPackaged) return;
    if (!String(process.env.GITHUB_OWNER || '').trim()) {
      process.env.GITHUB_OWNER = 'DidiG03';
    }
    if (!String(process.env.GITHUB_REPO || '').trim()) {
      process.env.GITHUB_REPO = 'POS';
    }
  } catch {
    // ignore
  }
}

ensurePackagedDefaults();

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'OneTap Admin',
    backgroundColor: '#0b1220',
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev,
    },
  });
  registerUpdateListener(mainWindow);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const cfg = readConfig();
  loadHash(mainWindow, cfg ? '/admin' : '/admin-setup');
  attachWindowRecovery(mainWindow);
}

ipcMain.handle('updater:getStatus', async () =>
  updaterHandlers.getUpdateStatus(),
);
ipcMain.handle('updater:checkForUpdates', async () =>
  updaterHandlers.checkForUpdates(),
);
ipcMain.handle('updater:downloadUpdate', async () =>
  updaterHandlers.downloadUpdate(),
);
ipcMain.handle('updater:installUpdate', async () =>
  updaterHandlers.installUpdate(),
);
ipcMain.handle('updater:deferInstall', async () =>
  updaterHandlers.deferInstall(),
);

ipcMain.handle('adminApp:getConfig', () => readConfig());

ipcMain.on('adminApp:getConfigSync', (event) => {
  event.returnValue = readConfig();
});

ipcMain.handle('adminApp:saveConfig', async (_e, payload) => {
  const existing = readConfig();
  const host = String(payload?.host ?? existing?.host ?? '').trim();
  const cfg: AdminConfig = {
    host,
    httpPort: Number(payload?.httpPort ?? existing?.httpPort) || 3333,
    httpsPort:
      payload?.httpsPort != null
        ? Number(payload.httpsPort) || undefined
        : existing?.httpsPort,
    businessCode:
      payload?.businessCode != null
        ? String(payload.businessCode)
        : existing?.businessCode,
  };
  if (!cfg.host) throw new Error('Host is required');
  writeConfig(cfg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    loadHash(mainWindow, '/admin', { bustCache: true });
  }
  return cfg;
});

ipcMain.handle('adminApp:resetConfig', () => {
  clearConfig();
  if (mainWindow && !mainWindow.isDestroyed())
    loadHash(mainWindow, '/admin-setup', { bustCache: true });
  return true;
});

ipcMain.handle('adminApp:testConnection', async (_e, payload) => {
  const host = String(payload?.host || '').trim();
  const httpPort = Number(payload?.httpPort) || 3333;
  if (!host) return { ok: false, error: 'Host is required' };
  const url = buildLanHttpUrl(host, httpPort, '/health');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json().catch(() => null as any);
    return { ok: true, body };
  } catch (e: any) {
    clearTimeout(t);
    const name = String(e?.name || '');
    const msg = String(e?.message || e || 'fetch failed');
    return {
      ok: false,
      error: name === 'AbortError' ? 'Timed out (host unreachable)' : msg,
    };
  }
});

ipcMain.handle('adminApp:discover', async () => {
  try {
    const { discoverPosHostsOnLan } = await import(
      '../services/posHostDiscover'
    );
    return await discoverPosHostsOnLan();
  } catch (e) {
    if (typeof console !== 'undefined')
      console.warn('[admin] discover failed:', e);
    return [];
  }
});

registerCompanionLanIpc({
  ipcMain,
  fetchChannel: 'adminApp:lanFetch',
  sseStartChannel: 'adminApp:lanSseStart',
  sseStopChannel: 'adminApp:lanSseStop',
  sseEventChannel: 'adminApp:lanSse',
  sseStatusChannel: 'adminApp:lanSseStatus',
  client: 'admin',
});

app.whenReady().then(() => {
  installOsResumeRecovery();
  setupAutoUpdater({
    channel: 'admin',
    autoDownload: false,
    autoInstallOnDownloaded: false,
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cleanupUpdater();
  if (process.platform !== 'darwin') app.quit();
});
