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
};

contextBridge.exposeInMainWorld('kdsApp', kdsApp);
contextBridge.exposeInMainWorld('__KDS_APP__', true);

// Hydrate `__POS_HOST__` synchronously when the page loads so the
// renderer's `pickBackend()` polyfill picks up the saved host without
// waiting for an IPC round-trip. We can't `await` here (preload runs
// before the renderer), so we fire-and-forget and the renderer re-reads
// on hash changes if it ever boots before this resolves (it won't in
// practice — preload returns to renderer before any user code runs).
void ipcRenderer.invoke('kdsApp:getConfig').then((cfg: KdsConfig | null) => {
  try {
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
});
