/**
 * Preload for the standalone "OneTap Admin" Electron app.
 *
 *   - `window.adminApp` — setup / discovery / connection test IPC
 *   - `window.__ADMIN_APP__ = true` so the renderer allows the admin shell
 *     over LAN (tablets still cannot open Admin)
 *   - `window.__POS_HOST__` so the HTTP polyfill targets the saved till
 */
import { contextBridge, ipcRenderer } from 'electron';

type AdminConfig = {
  host: string;
  httpPort: number;
  httpsPort?: number;
  businessCode?: string;
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

const updater = {
  getUpdateStatus: () => ipcRenderer.invoke('updater:getStatus'),
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('updater:installUpdate'),
  deferInstall: () => ipcRenderer.invoke('updater:deferInstall'),
};

const adminApp = {
  getConfig: (): Promise<AdminConfig | null> =>
    ipcRenderer.invoke('adminApp:getConfig'),
  saveConfig: (cfg: AdminConfig): Promise<AdminConfig> =>
    ipcRenderer.invoke('adminApp:saveConfig', cfg),
  resetConfig: (): Promise<boolean> =>
    ipcRenderer.invoke('adminApp:resetConfig'),
  discover: (): Promise<DiscoveredHost[]> =>
    ipcRenderer.invoke('adminApp:discover'),
  testConnection: (input: {
    host: string;
    httpPort: number;
  }): Promise<TestResult> =>
    ipcRenderer.invoke('adminApp:testConnection', input),
  updater,
};

contextBridge.exposeInMainWorld('adminApp', adminApp);
contextBridge.exposeInMainWorld('__ADMIN_APP__', true);

ipcRenderer.on('updater:event', (_e, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('updater:event', { detail: payload }));
  } catch {
    // ignore
  }
});

try {
  const cfg = ipcRenderer.sendSync(
    'adminApp:getConfigSync',
  ) as AdminConfig | null;
  if (cfg && cfg.host) {
    contextBridge.exposeInMainWorld('__POS_HOST__', {
      host: cfg.host,
      httpPort: cfg.httpPort,
      httpsPort: cfg.httpsPort || null,
    });
  }
} catch {
  // ignore
}
