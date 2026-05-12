/**
 * Standalone "Code Orbit KDS" Electron app.
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
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { dirname, join, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const MAIN_FILE = fileURLToPath(import.meta.url);
const MAIN_DIR = dirname(MAIN_FILE);
const MAIN_RUNTIME_DIR =
  basename(MAIN_DIR) === 'chunks' ? resolvePath(MAIN_DIR, '..') : MAIN_DIR;
const PRELOAD_PATH = join(MAIN_RUNTIME_DIR, '../preload/kds.cjs');
const RENDERER_INDEX_HTML = join(MAIN_RUNTIME_DIR, '../../renderer/index.html');

type KdsConfig = {
  host: string;
  httpPort: number;
  httpsPort?: number;
  businessCode?: string;
};

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

function loadHash(win: BrowserWindow, hash: '/kds' | '/kds-setup'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl + '#' + hash);
  } else {
    void win.loadFile(RENDERER_INDEX_HTML, { hash });
  }
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111827',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const cfg = readConfig();
  loadHash(mainWindow, cfg ? '/kds' : '/kds-setup');
}

// --- IPC: setup / discovery / connection test --------------------------------

ipcMain.handle('kdsApp:getConfig', () => readConfig());

ipcMain.handle('kdsApp:saveConfig', async (_e, payload) => {
  const cfg: KdsConfig = {
    host: String(payload?.host || '').trim(),
    httpPort: Number(payload?.httpPort) || 3333,
    httpsPort: payload?.httpsPort ? Number(payload.httpsPort) : undefined,
    businessCode: payload?.businessCode
      ? String(payload.businessCode)
      : undefined,
  };
  if (!cfg.host) throw new Error('Host is required');
  writeConfig(cfg);
  if (mainWindow && !mainWindow.isDestroyed()) loadHash(mainWindow, '/kds');
  return cfg;
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
  const url = `http://${host}:${httpPort}/kds/debug`;
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

// mDNS browse for ~2.5s, return any POS hosts found on the LAN.
ipcMain.handle('kdsApp:discover', async () => {
  type Found = {
    name?: string;
    host: string;
    httpPort: number;
    httpsPort?: number;
    addresses: string[];
    businessCode?: string;
  };
  const found = new Map<string, Found>();
  try {
    const { Bonjour } = await import('bonjour-service');
    const b = new Bonjour();
    return await new Promise<Found[]>((resolve) => {
      const browser = b.find(
        { type: 'codeorbit-pos', protocol: 'tcp' },
        (svc) => {
          const addresses = Array.isArray((svc as any).addresses)
            ? ((svc as any).addresses as string[])
            : [];
          const v4 =
            addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ||
            addresses[0];
          if (!v4) return;
          const txt = (svc.txt || {}) as Record<string, string>;
          const httpsPort = Number(txt.https) || undefined;
          const businessCode = txt.businessCode || undefined;
          const key = `${v4}:${svc.port}`;
          found.set(key, {
            name: (svc as any).name,
            host: v4,
            httpPort: svc.port || 3333,
            httpsPort,
            addresses,
            businessCode,
          });
        },
      );
      setTimeout(() => {
        try {
          browser.stop();
          b.destroy();
        } catch {
          // ignore
        }
        resolve(Array.from(found.values()));
      }, 2500);
    });
  } catch (e) {
    if (typeof console !== 'undefined')
      console.warn('[kds] discover failed:', e);
    return [] as Found[];
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
