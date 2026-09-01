/**
 * Preload for the standalone "OneTap KDS" Electron app.
 *
 * Intentionally tiny:
 *   - exposes `window.kdsApp`  — setup / discovery / connection test IPC
 *   - exposes `window.__KDS_APP__ = true`  so the renderer's auth gate
 *     can skip the user-login requirement (the KDS is a kiosk device).
 *   - exposes `window.__POS_HOST__ = { host, httpPort, httpsPort }`  so
 *     the renderer's HTTP polyfill (in main.tsx) targets the configured
 *     POS host instead of `window.location.hostname`.
 *
 * No DB, no printer, no POS IPC channels — everything else the KDS
 * renderer needs comes over HTTP from the configured POS host.
 */
// Preload must be CommonJS-compatible. Avoid top-level ESM-only features.
import { contextBridge, ipcRenderer } from 'electron';

type KdsTheme = 'dark' | 'light';

type KdsConfig = {
  host: string;
  httpPort: number;
  httpsPort?: number;
  businessCode?: string;
  station?: import('@shared/kdsStations').KdsStation;
  theme?: KdsTheme;
  cooker?: boolean;
};

type DiscoveredHost = {
  name?: string;
  host: string;
  httpPort: number;
  httpsPort?: number;
  addresses: string[];
  businessCode?: string;
};

type TestResult = { ok: true; body?: any } | { ok: false; error: string };

type KdsBumpBarAction = import('@shared/kdsBumpBar').KdsBumpBarAction;

const updater = {
  getUpdateStatus: () => ipcRenderer.invoke('updater:getStatus'),
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('updater:installUpdate'),
  deferInstall: () => ipcRenderer.invoke('updater:deferInstall'),
};

const kdsApp = {
  getConfig: (): Promise<KdsConfig | null> =>
    ipcRenderer.invoke('kdsApp:getConfig'),
  saveConfig: (cfg: KdsConfig): Promise<KdsConfig> =>
    ipcRenderer.invoke('kdsApp:saveConfig', cfg),
  saveDisplayStation: (
    station: import('@shared/kdsStations').KdsStation,
  ): Promise<import('@shared/kdsStations').KdsStation> =>
    ipcRenderer.invoke('kdsApp:saveDisplayStation', station),
  saveDisplayTheme: (theme: KdsTheme): Promise<KdsTheme> =>
    ipcRenderer.invoke('kdsApp:saveDisplayTheme', theme),
  saveDisplayCooker: (cooker: boolean): Promise<boolean> =>
    ipcRenderer.invoke('kdsApp:saveDisplayCooker', cooker),
  resetConfig: (): Promise<boolean> => ipcRenderer.invoke('kdsApp:resetConfig'),
  quit: (): Promise<boolean> => ipcRenderer.invoke('kdsApp:quit'),
  discover: (): Promise<DiscoveredHost[]> =>
    ipcRenderer.invoke('kdsApp:discover'),
  testConnection: (input: {
    host: string;
    httpPort: number;
  }): Promise<TestResult> => ipcRenderer.invoke('kdsApp:testConnection', input),
  onBumpBarAction: (cb: (action: KdsBumpBarAction) => void) => {
    const handler = (_e: unknown, action: KdsBumpBarAction) => cb(action);
    ipcRenderer.on('kds:bumpBarAction', handler);
    return () => {
      ipcRenderer.removeListener('kds:bumpBarAction', handler);
    };
  },
  updater,
};

contextBridge.exposeInMainWorld('kdsApp', kdsApp);
contextBridge.exposeInMainWorld('__KDS_APP__', true);

ipcRenderer.on('updater:event', (_e, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('updater:event', { detail: payload }));
  } catch {
    // ignore
  }
});

// Hydrate `__POS_HOST__` synchronously so `pickBackend()` in main.tsx
// targets the saved POS host on the first boot attempt.
try {
  const cfg = ipcRenderer.sendSync('kdsApp:getConfigSync') as KdsConfig | null;
  if (cfg && cfg.host) {
    contextBridge.exposeInMainWorld('__POS_HOST__', {
      host: cfg.host,
      httpPort: cfg.httpPort,
      httpsPort: cfg.httpsPort || null,
    });
  }
  if (cfg?.station) {
    contextBridge.exposeInMainWorld('__KDS_STATION__', cfg.station);
  }
  if (cfg?.theme) {
    contextBridge.exposeInMainWorld('__KDS_THEME__', cfg.theme);
  }
  contextBridge.exposeInMainWorld('__KDS_COOKER__', cfg?.cooker === true);
} catch {
  // ignore
}
