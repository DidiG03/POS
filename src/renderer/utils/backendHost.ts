import { buildLanHttpUrl, buildLanHttpsUrl } from '@shared/lanHost';
import { clearLanTokenMemory, writeLanToken } from './lanAuthToken';
import { invalidateHostScopedCaches } from './posReadCache';

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
    Boolean((import.meta as any)?.env?.VITE_MOBILE_TARGET) ||
    Boolean((window as any).Capacitor);
  const envHost = String(
    (import.meta as any)?.env?.VITE_DEFAULT_BACKEND_HOST || '',
  ).trim();
  const envHttp = String(
    (import.meta as any)?.env?.VITE_DEFAULT_BACKEND_HTTP || '',
  ).trim();
  const envHttps = String(
    (import.meta as any)?.env?.VITE_DEFAULT_BACKEND_HTTPS || '',
  ).trim();

  let host = 'localhost';
  let httpPort = '3333';
  let httpsPort = '3443';
  try {
    host =
      localStorage.getItem('pos_backend_host') ||
      envHost ||
      (isMobileShell ? '' : window.location.hostname) ||
      'localhost';
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
  }
}

/** @deprecated Use persistCompanionBackendHost */
export async function persistKdsBackendHost(input: {
  host: string;
  httpPort: number;
}): Promise<void> {
  return persistCompanionBackendHost(input);
}
