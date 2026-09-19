import { buildLanHttpUrl, buildLanHttpsUrl } from '@shared/lanHost';
import { clearLanTokenMemory, writeLanToken } from './lanAuthToken';
import { invalidateHostScopedCaches } from './posReadCache';
import { notifyBackendHostChanged } from './posServerScanEvent';

const NATIVE_HOST_KEY = 'pos_backend_host';
const NATIVE_HTTP_KEY = 'pos_backend_http';
const NATIVE_HTTPS_KEY = 'pos_backend_https';

export type BackendHost = {
  host: string;
  /** HTTP target; loopback when Admin/KDS is on the same machine as the till. */
  connectHost?: string;
  httpPort: string;
  httpsPort: string;
};

/** True when the renderer talks to the POS host over HTTP (tablets / KDS / Admin). */
export function isLanHttpClient(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    Boolean((window as any).__BROWSER_CLIENT__) ||
    Boolean((window as any).__KDS_APP__) ||
    Boolean((window as any).__ADMIN_APP__)
  );
}

/**
 * Host when nothing was injected via `__POS_HOST__`. Mobile must keep an
 * empty host when nothing is saved — `'' || 'localhost'` would send a
 * fresh Admin iOS install to `#/admin` and probe the phone itself.
 */
export function pickStoredBackendHost(input: {
  storedHost: string | null;
  envHost: string;
  isMobileShell: boolean;
  locationHostname: string;
}): string {
  const stored = String(input.storedHost || '').trim();
  if (stored) return stored;
  const env = String(input.envHost || '').trim();
  if (env) return env;
  if (input.isMobileShell) return '';
  return String(input.locationHostname || '').trim() || 'localhost';
}

/**
 * Single source of truth for which POS host LAN clients should call.
 * KDS: `window.__POS_HOST__` from kds.config.json (preload, sync read).
 * Tablets: localStorage / URL params / build-time defaults.
 */
export function resolveBackendHost(): BackendHost {
  const injected = (window as any).__POS_HOST__ as
    | {
        host?: string;
        connectHost?: string;
        httpPort?: number | string;
        httpsPort?: number | string | null;
      }
    | undefined;
  if (injected && typeof injected.host === 'string' && injected.host.trim()) {
    const host = injected.host.trim();
    const connectHost = String(injected.connectHost || host).trim();
    return {
      host,
      connectHost,
      httpPort: String(injected.httpPort || 3333),
      httpsPort: String(injected.httpsPort || 3443),
    };
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const backParam = params.get('backend');
    const httpParam = params.get('http');
    const httpsParam = params.get('https');
    if (backParam) localStorage.setItem('pos_backend_host', backParam);
    if (httpParam) localStorage.setItem('pos_backend_http', httpParam);
    if (httpsParam) localStorage.setItem('pos_backend_https', httpsParam);
  } catch {
    // ignore
  }

  const isMobileShell =
    Boolean(import.meta.env.VITE_MOBILE_TARGET) ||
    Boolean(import.meta.env.VITE_ADMIN_MOBILE_TARGET) ||
    Boolean((window as any).Capacitor);
  const envHost = String(
    import.meta.env.VITE_DEFAULT_BACKEND_HOST || '',
  ).trim();
  const envHttp = String(
    import.meta.env.VITE_DEFAULT_BACKEND_HTTP || '',
  ).trim();
  const envHttps = String(
    import.meta.env.VITE_DEFAULT_BACKEND_HTTPS || '',
  ).trim();

  let host = pickStoredBackendHost({
    storedHost: null,
    envHost,
    isMobileShell,
    locationHostname: '',
  });
  let httpPort = '3333';
  let httpsPort = '3443';
  try {
    host = pickStoredBackendHost({
      storedHost: localStorage.getItem('pos_backend_host'),
      envHost,
      isMobileShell,
      locationHostname: window.location.hostname,
    });
    httpPort = localStorage.getItem('pos_backend_http') || envHttp || '3333';
    httpsPort = localStorage.getItem('pos_backend_https') || envHttps || '3443';
  } catch {
    // ignore
  }

  return { host, httpPort, httpsPort };
}

export function hasConfiguredBackendHost(): boolean {
  return Boolean(resolveBackendHost().host.trim());
}

export function getHttpBase(): string {
  const { connectHost, host, httpPort } = resolveBackendHost();
  return buildLanHttpUrl(connectHost || host, httpPort);
}

export function getHttpsBase(): string {
  const { connectHost, host, httpsPort } = resolveBackendHost();
  return buildLanHttpsUrl(connectHost || host, httpsPort);
}

export function syncBackendHostToLocalStorage(input: {
  host: string;
  httpPort: string;
  httpsPort?: string;
}): void {
  const trimmedHost = input.host.trim();
  localStorage.setItem('pos_backend_host', trimmedHost);
  if (input.httpPort.trim())
    localStorage.setItem('pos_backend_http', input.httpPort.trim());
  else localStorage.removeItem('pos_backend_http');
  if (input.httpsPort?.trim())
    localStorage.setItem('pos_backend_https', input.httpsPort.trim());
  else localStorage.removeItem('pos_backend_https');
}

async function nativePreferences(): Promise<{
  get: (opts: { key: string }) => Promise<{ value: string | null }>;
  set: (opts: { key: string; value: string }) => Promise<void>;
} | null> {
  try {
    const Cap = (window as any).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    if (!Cap?.isNativePlatform?.()) return null;
    const { Preferences } = await import('@capacitor/preferences');
    // Never return the Cap plugin from an async function — plugins are
    // thenables that throw `"Preferences.then() is not implemented on ios"`.
    return {
      get: (opts) => Preferences.get(opts),
      set: (opts) => Preferences.set(opts),
    };
  } catch {
    return null;
  }
}

const NATIVE_HYDRATE_BUDGET_MS = 1_500;

/** Restore a saved till from Capacitor Preferences when localStorage is empty. */
export async function hydrateCompanionHostFromNativeStore(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    if (localStorage.getItem(NATIVE_HOST_KEY)?.trim()) return;
  } catch {
    // continue — Preferences may still have a host
  }
  // Cap Preferences can hang if the bridge is not ready yet. Budget so
  // Admin/Waiter boot never sticks on the HTML "OneTap POS" shell.
  await Promise.race([
    (async () => {
      const prefs = await nativePreferences();
      if (!prefs) return;
      try {
        const host = String(
          (await prefs.get({ key: NATIVE_HOST_KEY })).value || '',
        ).trim();
        if (!host) return;
        const httpPort = String(
          (await prefs.get({ key: NATIVE_HTTP_KEY })).value || '3333',
        ).trim();
        const httpsPort = String(
          (await prefs.get({ key: NATIVE_HTTPS_KEY })).value || '',
        ).trim();
        syncBackendHostToLocalStorage({
          host,
          httpPort: httpPort || '3333',
          httpsPort: httpsPort || undefined,
        });
      } catch {
        // ignore
      }
    })(),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, NATIVE_HYDRATE_BUDGET_MS);
    }),
  ]);
}

async function persistNativeCompanionHost(input: {
  host: string;
  httpPort: string;
}): Promise<void> {
  const prefs = await nativePreferences();
  if (!prefs) return;
  try {
    await prefs.set({ key: NATIVE_HOST_KEY, value: input.host });
    await prefs.set({ key: NATIVE_HTTP_KEY, value: input.httpPort });
  } catch {
    // ignore
  }
}

/**
 * Electron Admin/KDS persist via `saveConfig` and reload. Capacitor has no
 * IPC, so land on the companion shell and notify BootRoot to reconnect.
 */
export function companionPersistLocationHash(opts: {
  hasSaveConfig: boolean;
  adminApp: boolean;
  kdsApp: boolean;
}): string | null {
  if (opts.hasSaveConfig) return null;
  if (opts.adminApp) return '#/admin';
  if (opts.kdsApp) return '#/kds';
  return null;
}

export async function persistCompanionBackendHost(input: {
  host: string;
  httpPort: number;
}): Promise<void> {
  const trimmedHost = input.host.trim();
  const httpPort = Number(input.httpPort) || 3333;
  syncBackendHostToLocalStorage({
    host: trimmedHost,
    httpPort: String(httpPort),
  });
  await persistNativeCompanionHost({
    host: trimmedHost,
    httpPort: String(httpPort),
  });
  try {
    writeLanToken('pos_api_token', null, localStorage);
    writeLanToken('pos_host_api_token', null, localStorage);
    clearLanTokenMemory();
  } catch {
    // ignore
  }
  invalidateHostScopedCaches();
  try {
    const injected = (window as any).__POS_HOST__;
    if (injected && typeof injected === 'object') {
      injected.host = trimmedHost;
      injected.connectHost = trimmedHost;
      injected.httpPort = httpPort;
    }
  } catch {
    // contextBridge may freeze this object
  }
  const companion = ((window as any).adminApp || (window as any).kdsApp) as
    | {
        saveConfig?: (cfg: {
          host: string;
          httpPort: number;
        }) => Promise<unknown>;
      }
    | undefined;
  if (companion?.saveConfig) {
    await companion.saveConfig({ host: trimmedHost, httpPort });
    return;
  }
  const nextHash = companionPersistLocationHash({
    hasSaveConfig: false,
    adminApp: Boolean((window as any).__ADMIN_APP__),
    kdsApp: Boolean((window as any).__KDS_APP__),
  });
  if (nextHash) {
    try {
      window.location.hash = nextHash;
    } catch {
      // ignore
    }
    notifyBackendHostChanged();
  }
}

/** @deprecated Use persistCompanionBackendHost */
export async function persistKdsBackendHost(input: {
  host: string;
  httpPort: number;
}): Promise<void> {
  return persistCompanionBackendHost(input);
}
