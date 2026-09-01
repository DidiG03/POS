/**
 * Standalone "OneTap KDS" Electron app.
 *
 * The KDS bundle does NOT carry the POS database, the LAN API server,
 * printer drivers, or auto-updater for the POS — it's a thin client
 * that talks HTTP to a POS host on the LAN. This makes the installer
 * small (~80 MB instead of ~250 MB) and lets kitchens upgrade or
 * uninstall the display without touching the POS.
 *
 * Bootstrapping:
 *   1. Read saved host config from `<userData>/kds.config.json`.
 *   2. If configured, load `index.html#/kds` directly.
 *   3. Otherwise, load `#/kds-setup` which lets the user discover via
 *      mDNS or type a host manually, test the connection, and save.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { buildLanHttpUrl } from '@shared/lanHost';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { attachKdsBumpBarInput } from './bumpBarInput';
import { parseKdsStation, type KdsStation } from '@shared/kdsStations';
import {
  cleanup as cleanupUpdater,
  registerUpdateListener,
  setupAutoUpdater,
  updaterHandlers,
} from '../updater';

app.setName('OneTap KDS');

const MAIN_FILE = fileURLToPath(import.meta.url);
const MAIN_DIR = dirname(MAIN_FILE);
const MAIN_RUNTIME_DIR =
  basename(MAIN_DIR) === 'chunks' ? resolvePath(MAIN_DIR, '..') : MAIN_DIR;
const PRELOAD_PATH = join(MAIN_RUNTIME_DIR, '../preload/kds.cjs');
const RENDERER_INDEX_HTML = join(MAIN_RUNTIME_DIR, '../../renderer/index.html');

type KdsTheme = 'dark' | 'light';

type KdsConfig = {
  host: string;
  httpPort: number;
  httpsPort?: number;
  businessCode?: string;
  station?: KdsStation;
  theme?: KdsTheme;
  /** This screen is the cooker's display (first kitchen stage). */
  cooker?: boolean;
};

function parseTheme(value: unknown): KdsTheme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}

function configPath(): string {
  return join(app.getPath('userData'), 'kds.config.json');
}

function readConfig(): KdsConfig | null {
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
      station: parseKdsStation(j.station) ?? undefined,
      theme: parseTheme(j.theme),
      cooker: j.cooker === true ? true : undefined,
    };
  } catch {
    return null;
  }
}

function writeConfig(cfg: KdsConfig): void {
  try {
    fs.mkdirSync(dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    if (typeof console !== 'undefined')
      console.warn('[kds] failed to save config:', e);
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
/** When true, skip the bump-bar focus steal so quit / system dialogs can work. */
let quitting = false;

async function quitKdsApp(): Promise<boolean> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const wasFullscreen = Boolean(win?.isFullScreen());
  const wasAlwaysOnTop = Boolean(win?.isAlwaysOnTop());

  if (win) {
    try {
      if (wasFullscreen) win.setFullScreen(false);
      if (wasAlwaysOnTop) win.setAlwaysOnTop(false);
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const quitDialog = {
    type: 'question' as const,
    buttons: ['Cancel', 'Quit KDS'],
    defaultId: 0,
    cancelId: 0,
    title: 'OneTap KDS',
    message: 'Quit OneTap KDS?',
    detail: 'You can reopen it from the desktop or Start menu.',
  };
  const { response } = win
    ? await dialog.showMessageBox(win, quitDialog)
    : await dialog.showMessageBox(quitDialog);

  if (response !== 1) {
    if (win && !win.isDestroyed()) {
      try {
        if (wasAlwaysOnTop) win.setAlwaysOnTop(true);
        if (wasFullscreen) win.setFullScreen(true);
        win.focus();
      } catch {
        // ignore
      }
    }
    return false;
  }

  quitting = true;
  app.quit();
  return true;
}

function loadHash(win: BrowserWindow, hash: '/kds' | '/kds-setup'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl + '#' + hash);
  } else {
    void win.loadFile(RENDERER_INDEX_HTML, { hash });
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
  const isProdKds = !process.env.ELECTRON_RENDERER_URL;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'OneTap KDS',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    show: false,
    fullscreen: isProdKds,
    alwaysOnTop: isProdKds,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !isProdKds,
    },
  });
  attachKdsBumpBarInput(mainWindow);
  registerUpdateListener(mainWindow);
  mainWindow.once('ready-to-show', () => {
    if (isProdKds) mainWindow?.setFullScreen(true);
    mainWindow?.show();
  });
  // Dedicated kitchen display: keep focus on the KDS window for the bump bar.
  mainWindow.on('blur', () => {
    if (quitting) return;
    setTimeout(() => {
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.focus();
    }, 150);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const cfg = readConfig();
  loadHash(mainWindow, cfg ? '/kds' : '/kds-setup');
}

// --- IPC: setup / discovery / connection test --------------------------------

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

ipcMain.handle('kdsApp:quit', () => quitKdsApp());

ipcMain.handle('kdsApp:getConfig', () => readConfig());

// Synchronous read for preload — `pickBackend()` runs before any async IPC
// resolves, so the saved host must be on `window.__POS_HOST__` immediately.
ipcMain.on('kdsApp:getConfigSync', (event) => {
  event.returnValue = readConfig();
});

ipcMain.handle('kdsApp:saveConfig', async (_e, payload) => {
  const existing = readConfig();
  const host = String(payload?.host ?? existing?.host ?? '').trim();
  const cfg: KdsConfig = {
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
    station:
      payload?.station != null
        ? (parseKdsStation(payload.station) ?? existing?.station)
        : existing?.station,
    theme:
      payload?.theme != null
        ? (parseTheme(payload.theme) ?? existing?.theme)
        : existing?.theme,
    cooker:
      payload?.cooker != null ? Boolean(payload.cooker) : existing?.cooker,
  };
  if (!cfg.host) throw new Error('Host is required');
  writeConfig(cfg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Navigate to KDS — this reloads preload so `__POS_HOST__` picks up
    // the saved config. Do not call reload() separately (race with loadHash).
    loadHash(mainWindow, '/kds');
  }
  return cfg;
});

ipcMain.handle('kdsApp:saveDisplayStation', async (_e, payload) => {
  const station = parseKdsStation(payload);
  if (!station) throw new Error('Invalid KDS station');
  const existing = readConfig();
  if (existing) writeConfig({ ...existing, station });
  return station;
});

ipcMain.handle('kdsApp:saveDisplayTheme', async (_e, payload) => {
  const theme = parseTheme(payload);
  if (!theme) throw new Error('Invalid KDS theme');
  const existing = readConfig();
  if (existing) writeConfig({ ...existing, theme });
  return theme;
});

ipcMain.handle('kdsApp:saveDisplayCooker', async (_e, payload) => {
  const cooker = Boolean(payload);
  const existing = readConfig();
  if (existing) writeConfig({ ...existing, cooker });
  return cooker;
});

ipcMain.handle('kdsApp:resetConfig', () => {
  clearConfig();
  if (mainWindow && !mainWindow.isDestroyed())
    loadHash(mainWindow, '/kds-setup');
  return true;
});

// Quick reachability test against `/kds/debug` (a public LAN route on
// the POS host that returns schema readiness + counts).
ipcMain.handle('kdsApp:testConnection', async (_e, payload) => {
  const host = String(payload?.host || '').trim();
  const httpPort = Number(payload?.httpPort) || 3333;
  if (!host) return { ok: false, error: 'Host is required' };
  const url = buildLanHttpUrl(host, httpPort, '/kds/debug');
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

// Find POS tills on the LAN (mDNS + HTTP /kds/debug walk).
ipcMain.handle('kdsApp:discover', async () => {
  try {
    const { discoverPosHostsOnLan } = await import(
      '../services/posHostDiscover'
    );
    return await discoverPosHostsOnLan();
  } catch (e) {
    if (typeof console !== 'undefined')
      console.warn('[kds] discover failed:', e);
    return [];
  }
});

// --- Lifecycle ---------------------------------------------------------------

app.whenReady().then(() => {
  // Empty application menu — kitchen display is a kiosk; staff don't need
  // File/Edit/View. The system shortcut for DevTools (F12) still works.
  try {
    Menu.setApplicationMenu(null);
  } catch {
    // ignore
  }
  // Kitchen displays are unattended kiosks: fetch updates automatically
  // and restart-and-install on their own (with a deferrable on-screen
  // countdown) so "pushing an update" never means physically reinstalling.
  setupAutoUpdater({
    channel: 'kds',
    autoDownload: true,
    autoInstallOnDownloaded: true,
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
