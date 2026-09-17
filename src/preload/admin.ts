/**
 * Preload for the standalone "OneTap Admin" Electron app.
 *
 *   - `window.adminApp` — setup / discovery / connection test IPC
 *   - `window.__ADMIN_APP__ = true` so the renderer allows the admin shell
 *     over LAN (tablets still cannot open Admin)
 *   - `window.__POS_HOST__` so the HTTP polyfill targets the saved till
 */
import os from 'node:os';
import { contextBridge, ipcRenderer } from 'electron';
import { httpHostForLocalPos } from '@shared/localPosHost';

function localInterfaceAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni?.address) out.push(ni.address);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

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
  checkDownloadAndPrepare: () =>
    ipcRenderer.invoke('updater:checkDownloadAndPrepare'),
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
  lanFetch: (input: {
    host: string;
    httpPort: number;
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }) => ipcRenderer.invoke('adminApp:lanFetch', input),
  lanSseStart: (input: { host: string; httpPort: number; path: string }) =>
    ipcRenderer.invoke('adminApp:lanSseStart', input),
  lanSseStop: () => ipcRenderer.invoke('adminApp:lanSseStop'),
  onLanSse: (cb: (payload: { event?: string; data?: string }) => void) => {
    const handler = (_e: unknown, payload: { event?: string; data?: string }) =>
      cb(payload);
    ipcRenderer.on('adminApp:lanSse', handler);
    return () => ipcRenderer.removeListener('adminApp:lanSse', handler);
  },
  onLanSseStatus: (
    cb: (payload: { status?: string; error?: string }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { status?: string; error?: string },
    ) => cb(payload);
    ipcRenderer.on('adminApp:lanSseStatus', handler);
    return () => ipcRenderer.removeListener('adminApp:lanSseStatus', handler);
  },
  updater,
  showMessageBox: (opts: Electron.MessageBoxOptions) =>
    ipcRenderer.invoke('adminApp:showMessageBox', opts),
  fleetMenuFinished: () => ipcRenderer.invoke('updater:fleetMenuFinished'),
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

ipcRenderer.on('updater:run-fleet-check', () => {
  try {
    window.dispatchEvent(new CustomEvent('updater:run-fleet-check'));
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
      connectHost: httpHostForLocalPos(cfg.host, localInterfaceAddresses()),
      httpPort: cfg.httpPort,
      httpsPort: cfg.httpsPort || null,
    });
  }
} catch {
  // ignore
}
