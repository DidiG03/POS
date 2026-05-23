/**
 * Preload for the standalone "Code Orbit KDS" Electron app.
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

type KdsConfig = {
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

type KdsBumpBarAction = import('@shared/kdsBumpBar').KdsBumpBarAction;

const kdsApp = {
  getConfig: (): Promise<KdsConfig | null> =>
    ipcRenderer.invoke('kdsApp:getConfig'),
  saveConfig: (cfg: KdsConfig): Promise<KdsConfig> =>
    ipcRenderer.invoke('kdsApp:saveConfig', cfg),
  resetConfig: (): Promise<boolean> => ipcRenderer.invoke('kdsApp:resetConfig'),
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
};

contextBridge.exposeInMainWorld('kdsApp', kdsApp);
contextBridge.exposeInMainWorld('__KDS_APP__', true);

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
} catch {
  // ignore
}
