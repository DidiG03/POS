/**
 * Tablet / browser `window.api` over the till LAN.
 * Electron preload already defines `window.api`; this module is loaded only
 * when that bridge is missing so the PIN screen does not download it.
 */
import {
  getHttpBase,
  getHttpsBase,
  resolveBackendHost,
} from './utils/backendHost';
import { isHostOrAdminRole, jwtRole } from '@shared/jwtRole';
import {
  getPreferredScheme,
  isSseHealthy,
  lanBases,
  markSseOpen,
  noteSseEvent,
  recordFailure,
  recordSuccess,
  readRetryAttempts,
  setPreferredScheme,
} from './utils/netQuality';
import {
  emitPosSyncCatchup,
  emitPosSyncCatchupSoon,
} from './utils/posReadCache';
import { POS_BACKEND_HOST_CHANGED } from './utils/posServerScanEvent';
import { clearInflight, dedupe } from './utils/swrCache';
import {
  lanAuthGeneration,
  lanDedupeKey,
  readLanToken,
  shouldForceLogoutOn401,
  writeLanToken,
} from './utils/lanAuthToken';
import { isPairingRejectedError } from './utils/lanLoginError';
import { syncTabletToHostVersion } from './utils/syncTabletToHostVersion';

export function installBrowserLanApi(): void {
  if ((window as any).api) return;

  let IS_NATIVE_SHELL = false;
  const TOKEN_KEY_POS = 'pos_api_token';
  const TOKEN_KEY_HOST = 'pos_host_api_token';

  function isReservationsShell(): boolean {
    try {
      const hash = window.location.hash || '';
      const path = window.location.pathname || '';
      const href = window.location.href || '';
      return (
        hash.includes('/reservations') ||
        path.includes('/reservations') ||
        href.includes('#/reservations')
      );
    } catch {
      return false;
    }
  }

  function tokenKeyForShell(): string {
    return isReservationsShell() ? TOKEN_KEY_HOST : TOKEN_KEY_POS;
  }

  function storageOrNull(): Storage | null {
    try {
      return localStorage;
    } catch {
      return null;
    }
  }

  function readStoredToken(key: string): string | null {
    return readLanToken(key, storageOrNull());
  }

  function writeStoredToken(key: string, t: string | null) {
    writeLanToken(key, t, storageOrNull());
  }

  /** Prefer the host PIN token for the reservations panel and merge saves. */
  function hostApiToken(): string | null {
    const host = readStoredToken(TOKEN_KEY_HOST);
    if (host && isHostOrAdminRole(jwtRole(host))) return host;
    const shared = readStoredToken(TOKEN_KEY_POS);
    if (shared && isHostOrAdminRole(jwtRole(shared))) return shared;
    // Decode failed (some WebViews choke on JWT padding) but this key is
    // only written on a host/admin login, so still send it.
    return host || null;
  }

  const getToken = () => {
    try {
      if (isReservationsShell()) {
        return hostApiToken();
      }
      return readStoredToken(TOKEN_KEY_POS);
    } catch (e) {
      void e;
      return null;
    }
  };
  const setToken = (t: string | null) => {
    try {
      writeStoredToken(tokenKeyForShell(), t);
      if (t && (isReservationsShell() || isHostOrAdminRole(jwtRole(t)))) {
        writeStoredToken(TOKEN_KEY_HOST, t);
      }
      clearInflight('lan:');
    } catch (e) {
      void e;
    }
  };

  function tokenForLanPath(path: string): string | null {
    const pathname = String(path || '').split('?')[0];
    if (
      pathname === '/auth/login' ||
      pathname === '/pairing/verify' ||
      pathname === '/auth/users' ||
      pathname === '/events/login' ||
      pathname === '/health'
    ) {
      return null;
    }
    if (
      pathname.startsWith('/layout/merges') ||
      pathname.startsWith('/reservations') ||
      pathname === '/tables/open' ||
      pathname === '/tickets/tooltip'
    ) {
      // Host PIN first; the waiter token still works for merge saves.
      return hostApiToken() || readStoredToken(TOKEN_KEY_POS) || getToken();
    }
    return getToken();
  }

  const pickBackend = () => {
    // Side effects for URL params + mobile shell detection; resolution lives in
    // `resolveBackendHost()` so every HTTP call uses the same host source.
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
    IS_NATIVE_SHELL =
      Boolean((import.meta as any)?.env?.VITE_MOBILE_TARGET) ||
      Boolean((window as any).Capacitor);
    return resolveBackendHost();
  };
  pickBackend();
  /**
   * Tablets on LAN Wi‑Fi often need more than 5s; desktops stay snappy.
   *
   * Budget phones are the real constraint, not the link: a mid-range Android
   * can spend a second or more just parsing a floor snapshot while four polls
   * are in flight, and a 5s ceiling aborted reads the host had already
   * answered. Every one of those aborts feeds `recordFailure()`, which trips
   * `isLinkDegraded()` and stretches all polling to 12s — so a phone that was
   * merely busy ended up looking offline and serving stale tables.
   */
  const CLIENT_TIMEOUT_MS = IS_NATIVE_SHELL ? 15_000 : 4_000;
  const CLIENT_GET_TIMEOUT_MS = IS_NATIVE_SHELL ? 10_000 : 3_000;
  /**
   * `/print/*` hits the host, then fiskalizimi, then TCP to the printer.
   *
   * This MUST stay above the host's worst case or we abort a payment the
   * host is still working on: `easyPosRequest` allows 3 attempts at a 20s
   * timeout with 1s+2s backoff (~63s) before the receipt is even
   * dispatched. The host's fiscal claim makes an early abort safe rather
   * than duplicating an invoice, but aborting still turns a slow payment
   * into a queued retry the waiter has to wait out.
   */
  const LAN_PRINT_TIMEOUT_MS = 90_000;

  function companionLanApi():
    | {
        lanFetch?: (input: {
          host: string;
          httpPort: number;
          path: string;
          method?: string;
          headers?: Record<string, string>;
          body?: string;
          timeoutMs?: number;
        }) => Promise<{
          status: number;
          ok: boolean;
          headers: Record<string, string>;
          body: string;
        }>;
        lanSseStart?: (input: {
          host: string;
          httpPort: number;
          path: string;
        }) => Promise<unknown>;
        lanSseStop?: () => Promise<unknown>;
        onLanSse?: (
          cb: (payload: { event?: string; data?: string }) => void,
        ) => () => void;
        onLanSseStatus?: (
          cb: (payload: { status?: string; error?: string }) => void,
        ) => () => void;
      }
    | undefined {
    return (window as any).adminApp || (window as any).kdsApp;
  }

  function headersToRecord(
    headers?: HeadersInit | Record<string, string>,
  ): Record<string, string> {
    if (!headers) return {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      const out: Record<string, string> = {};
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) {
      const out: Record<string, string> = {};
      for (const [key, value] of headers) out[String(key)] = String(value);
      return out;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      headers as Record<string, string>,
    )) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  async function fetchWithTimeout(
    input: RequestInfo | URL,
    init?: RequestInit,
    timeoutMs = CLIENT_TIMEOUT_MS,
  ) {
    const companion = companionLanApi();
    if (companion?.lanFetch) {
      const url = String(input);
      const httpBase = getHttpBase();
      const httpsBase = getHttpsBase();
      let path: string | null = null;
      if (url.startsWith(httpBase)) path = url.slice(httpBase.length) || '/';
      else if (url.startsWith(httpsBase))
        path = url.slice(httpsBase.length) || '/';
      if (path) {
        if (!path.startsWith('/')) path = `/${path}`;
        const backend = resolveBackendHost();
        try {
          const result = await companion.lanFetch({
            host: backend.connectHost || backend.host,
            httpPort: Number(backend.httpPort) || 3333,
            path,
            method: init?.method,
            headers: headersToRecord(init?.headers as any),
            body: typeof init?.body === 'string' ? init.body : undefined,
            timeoutMs,
          });
          return new Response(result.body, {
            status: result.status,
            headers: result.headers,
          });
        } catch (e: any) {
          const name = String(e?.name || '');
          if (name === 'AbortError') throw e;
          throw new TypeError(String(e?.message || e || 'Failed to fetch'));
        }
      }
    }
    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      window.clearTimeout(t);
    }
  }

  // Resilient SSE client for real-time updates.
  //
  // EventSource auto-reconnects on transport errors, but it doesn't help when
  // the WebView is suspended (Android background kill, iOS tab freezing) or
  // when the user roams between Wi-Fi APs and the existing socket goes silent
  // without raising `error`. We layer three safety nets on top of the native
  // retry:
  //   1. Manual reconnect with exponential backoff when `error` fires while
  //      the connection is in a non-OPEN state. EventSource's built-in retry
  //      can stall after a closed socket if it never received `retry:`.
  //   2. Force-reconnect when the document becomes visible again, the device
  //      goes back online, or the page is restored from bfcache. These are
  //      the realistic ways SSE dies silently on a real tablet.
  //   3. A periodic health ping (closed/CONNECTING for > 30s ⇒ reconnect)
  //      so we never sit on a half-open socket indefinitely.
  let es: EventSource | null = null;
  let sseReconnectTimer: number | null = null;
  let sseHealthTimer: number | null = null;
  let sseBackoffMs = 1000;
  const SSE_MAX_BACKOFF_MS = 30_000;
  const SSE_HEALTH_INTERVAL_MS = 15_000;
  const SSE_STALL_THRESHOLD_MS = 30_000;
  let lastSseEventAt = 0;

  const stopSse = () => {
    try {
      if (sseReconnectTimer != null) {
        window.clearTimeout(sseReconnectTimer);
        sseReconnectTimer = null;
      }
    } catch {
      // ignore
    }
    try {
      if (sseHealthTimer != null) {
        window.clearInterval(sseHealthTimer);
        sseHealthTimer = null;
      }
    } catch {
      // ignore
    }
    try {
      if (es) es.close();
    } catch {
      // ignore
    }
    es = null;
  };

  const scheduleSseReconnect = () => {
    if (sseReconnectTimer != null) return;
    const delay = sseBackoffMs;
    sseBackoffMs = Math.min(SSE_MAX_BACKOFF_MS, sseBackoffMs * 2);
    sseReconnectTimer = window.setTimeout(() => {
      sseReconnectTimer = null;
      startSse();
    }, delay);
  };

  const handleSseEvent = (eventName: string, payload: unknown) => {
    lastSseEventAt = Date.now();
    noteSseEvent();
    // Any incoming message proves the socket is healthy — reset backoff
    // so a future drop reconnects fast instead of compounding from the
    // last failure window.
    sseBackoffMs = 1000;
    try {
      window.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
    } catch {
      // ignore — listener fan-out is best-effort
    }
  };

  const applySseNamedEvent = (eventName: string, rawData: string) => {
    if (eventName === 'ping') {
      lastSseEventAt = Date.now();
      noteSseEvent();
      return;
    }
    if (eventName === 'catchup') {
      emitPosSyncCatchup();
      return;
    }
    let data: any = {};
    try {
      data = JSON.parse(rawData || '{}');
    } catch {
      if (eventName !== 'apps-update') emitPosSyncCatchupSoon();
      return;
    }
    if (eventName === 'tables') {
      const { area, label, open } = data || {};
      if (area && label && typeof open === 'boolean') {
        const store = (window as any).__tableStatusStore__;
        if (store && store.setOpen) store.setOpen(area, label, open);
      }
      handleSseEvent('pos:tablesChanged', data);
      return;
    }
    if (eventName === 'reservations') {
      handleSseEvent('pos:reservationsChanged', data);
      return;
    }
    if (eventName === 'ticket') {
      handleSseEvent('pos:ticketsChanged', data);
      return;
    }
    if (eventName === 'layout') {
      handleSseEvent('pos:layoutChanged', data);
      return;
    }
    if (eventName === 'tableMerges') {
      handleSseEvent('pos:tableMergesChanged', data);
      return;
    }
    if (eventName === 'settings') {
      handleSseEvent('pos:settingsChanged', data);
      return;
    }
    if (eventName === 'users') {
      handleSseEvent('pos:usersChanged', data);
      return;
    }
    if (eventName === 'apps-update') {
      handleSseEvent('pos:appsUpdate', data);
    }
  };

  let companionSseBound = false;
  const bindCompanionSse = () => {
    const companion = companionLanApi();
    if (!companion?.onLanSse || companionSseBound) return;
    companionSseBound = true;
    companion.onLanSse((payload) => {
      applySseNamedEvent(
        String(payload?.event || ''),
        String(payload?.data ?? '{}'),
      );
    });
    companion.onLanSseStatus?.((payload) => {
      const status = String(payload?.status || '');
      if (status === 'open') {
        if (es) (es as any).readyState = 1;
        lastSseEventAt = Date.now();
        sseBackoffMs = 1000;
        markSseOpen(true);
        emitPosSyncCatchupSoon();
        void syncTabletToHostVersion();
        return;
      }
      if (status === 'error') {
        markSseOpen(false);
        if (getToken()) {
          window.setTimeout(() => {
            void goLan('/notifications?limit=1').catch(() => undefined);
          }, 0);
        }
        return;
      }
      if (status === 'close') {
        markSseOpen(false);
        if (!es) return;
        stopSse();
        scheduleSseReconnect();
      }
    });
  };

  const startCompanionSse = (): boolean => {
    const companion = companionLanApi();
    if (!companion?.lanSseStart) return false;
    bindCompanionSse();
    const token = getToken();
    const backend = resolveBackendHost();
    const client = (window as any).__ADMIN_APP__
      ? 'admin'
      : (window as any).__KDS_APP__
        ? 'kds'
        : '';
    const path = token
      ? `/events?token=${encodeURIComponent(token)}${
          client ? `&client=${client}` : ''
        }`
      : `/events/login${client ? `?client=${client}` : ''}`;
    es = {
      readyState: 0,
      close() {
        try {
          void companion.lanSseStop?.();
        } catch {
          // ignore
        }
      },
    } as EventSource;
    lastSseEventAt = Date.now();
    void companion
      .lanSseStart({
        host: backend.host,
        httpPort: Number(backend.httpPort) || 3333,
        path,
      })
      .catch(() => {
        markSseOpen(false);
        scheduleSseReconnect();
      });
    return true;
  };

  const startSse = () => {
    try {
      // Keep this callable so boot / login can restart SSE without crashing.
      const token = getToken();
      // Tear down the previous EventSource before opening a new one. We do
      // this unconditionally so a `startSse()` triggered by a visibility
      // change reliably replaces a half-open socket.
      if (es) {
        try {
          es.close();
        } catch {
          // ignore
        }
        es = null;
      }
      if (!startCompanionSse()) {
        const nativeQ = IS_NATIVE_SHELL ? 'client=native' : '';
        // PIN screen has no JWT. `/events/login` only emits staff-directory
        // changes so iOS/Android see new waiters without a refresh.
        const url = token
          ? `${getHttpBase()}/events?token=${encodeURIComponent(token)}` +
            (nativeQ ? `&${nativeQ}` : '')
          : `${getHttpBase()}/events/login${nativeQ ? `?${nativeQ}` : ''}`;
        es = new EventSource(url);
        lastSseEventAt = Date.now();

        es.addEventListener('open', () => {
          lastSseEventAt = Date.now();
          sseBackoffMs = 1000;
          markSseOpen(true);
          // Android/iOS drop EventSource while backgrounded; missed voids and
          // table closes never replay. Refetch as soon as the socket is back.
          emitPosSyncCatchupSoon();
          void syncTabletToHostVersion();
        });

        es.addEventListener('error', () => {
          markSseOpen(false);
          const state = es?.readyState;
          if (state === 2 /* CLOSED */ || !es) {
            stopSse();
            // EventSource does not expose the HTTP status. A dead JWT closes
            // the socket and would otherwise reconnect forever while the PIN
            // session stays on screen. Probe a session route so 401 logs out.
            if (getToken()) {
              window.setTimeout(() => {
                void goLan('/notifications?limit=1').catch(() => undefined);
              }, 0);
            }
            scheduleSseReconnect();
            return;
          }
          // CONNECTING: let the browser try once; if it still hasn't reopened
          // by the next health tick, the watchdog will force a reconnect.
        });

        es.addEventListener('ping', (ev: any) => {
          applySseNamedEvent('ping', ev?.data || '{}');
        });
        es.addEventListener('tables', (ev: any) => {
          applySseNamedEvent('tables', ev?.data || '{}');
        });
        es.addEventListener('reservations', (ev: any) => {
          applySseNamedEvent('reservations', ev?.data || '{}');
        });
        es.addEventListener('ticket', (ev: any) => {
          applySseNamedEvent('ticket', ev?.data || '{}');
        });
        es.addEventListener('layout', (ev: any) => {
          applySseNamedEvent('layout', ev?.data || '{}');
        });
        es.addEventListener('tableMerges', (ev: any) => {
          applySseNamedEvent('tableMerges', ev?.data || '{}');
        });
        es.addEventListener('settings', (ev: any) => {
          applySseNamedEvent('settings', ev?.data || '{}');
        });
        es.addEventListener('users', (ev: any) => {
          applySseNamedEvent('users', ev?.data || '{}');
        });
        es.addEventListener('apps-update', (ev: any) => {
          applySseNamedEvent('apps-update', ev?.data || '{}');
        });
        es.addEventListener('catchup', () => {
          applySseNamedEvent('catchup', '{}');
        });
      }

      // Watchdog: if the socket hasn't received anything for a long time
      // AND isn't OPEN, force a reconnect. We accept the (small) cost of
      // an extra ping cycle to guarantee real-time stays real.
      if (sseHealthTimer == null) {
        sseHealthTimer = window.setInterval(() => {
          if (!es) {
            scheduleSseReconnect();
            return;
          }
          const since = Date.now() - lastSseEventAt;
          const stalled = since > SSE_STALL_THRESHOLD_MS;
          const open = es.readyState === 1; /* OPEN */
          if (!open && stalled) {
            stopSse();
            scheduleSseReconnect();
          }
        }, SSE_HEALTH_INTERVAL_MS);
      }
    } catch (e) {
      void e;
      scheduleSseReconnect();
    }
  };

  const ensureSse = () => {
    // Called from foreground / online / pageshow listeners. If the socket
    // is missing or not OPEN, restart it with a fresh backoff so we don't
    // wait the full timeout the user just slept through.
    if (!es) {
      sseBackoffMs = 1000;
      if (sseReconnectTimer != null) {
        window.clearTimeout(sseReconnectTimer);
        sseReconnectTimer = null;
      }
      startSse();
      return;
    }
    if (es.readyState !== 1 /* OPEN */) {
      sseBackoffMs = 1000;
      stopSse();
      startSse();
    }
  };

  startSse();

  // Ensure "manual logout" clears the browser token + closes SSE.
  try {
    window.addEventListener('pos:forceLogout', () => {
      try {
        setToken(null);
      } catch {
        // ignore
      }
      stopSse();
      startSse();
    });
    window.addEventListener('pagehide', stopSse);
    // Foreground / connectivity recovery: the three signals that reliably
    // fire when a real device wakes the WebView back up. Each one forces a
    // fresh SSE handshake so backgrounded tablets catch up the moment the
    // user looks at the panel again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        ensureSse();
        void syncTabletToHostVersion();
        // A healthy socket already delivered tables/tickets/settings.
        // Full cache drops belong to a dead EventSource or OS resume.
        if (!isSseHealthy()) emitPosSyncCatchupSoon();
      }
    });
    window.addEventListener('focus', () => ensureSse());
    window.addEventListener('online', () => ensureSse());
    // bfcache restore (iOS, modern Chromium) — `pageshow.persisted === true`
    // means the page was resurrected from cache with all timers paused.
    window.addEventListener('pageshow', (ev: any) => {
      if (ev && ev.persisted) ensureSse();
    });
    window.addEventListener(POS_BACKEND_HOST_CHANGED, () => {
      sseBackoffMs = 1000;
      stopSse();
      startSse();
    });
  } catch {
    // ignore
  }

  function isRetryableNetworkError(e: any) {
    const name = String(e?.name || '');
    // fetch() network failures are commonly TypeError; timeouts become AbortError
    return name === 'AbortError' || e instanceof TypeError;
  }

  async function fetchWithRetry(
    url: string,
    init: RequestInit,
    attempts = 2,
    timeoutMs = CLIENT_TIMEOUT_MS,
  ) {
    let lastErr: any = null;
    const tries = Math.max(1, attempts);
    for (let i = 0; i < tries; i++) {
      try {
        const started = Date.now();
        const res = await fetchWithTimeout(url, init, timeoutMs);
        recordSuccess(Date.now() - started);
        return res;
      } catch (e: any) {
        lastErr = e;
        recordFailure();
        if (!isRetryableNetworkError(e) || i === tries - 1) throw e;
        const delay = Math.min(800, 150 * Math.pow(2, i));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  class HttpError extends Error {
    status: number;
    code?: string;
    permanent?: boolean;
    constructor(
      status: number,
      message?: string,
      code?: string,
      permanent?: boolean,
    ) {
      super(message || String(status));
      this.status = status;
      if (code) this.code = code;
      if (permanent) this.permanent = true;
    }
  }

  // Extract `{ error, code, permanent }` from an error response body when
  // present so user-facing surfaces (e.g. fiscal 409) get the real message
  // instead of the bare HTTP status code.
  async function readErrorMessage(
    r: Response,
  ): Promise<{ message?: string; code?: string; permanent?: boolean }> {
    try {
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return {};
      const body: any = await r.json().catch(() => null);
      if (!body || typeof body !== 'object') return {};
      const message =
        typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : undefined;
      const code = typeof body.code === 'string' ? body.code : undefined;
      const permanent = body.permanent === true ? true : undefined;
      return { message, code, permanent };
    } catch {
      return {};
    }
  }

  function forceLogout(reason: string) {
    try {
      setToken(null);
    } catch {
      // ignore
    }
    stopSse();
    try {
      window.dispatchEvent(
        new CustomEvent('pos:forceLogout', { detail: { reason } }),
      );
    } catch {
      // ignore
    }
  }

  // 401 = the token is missing or no longer valid. 403 is "you're signed in
  // but this route is not for you" (LAN policy, clock-only roles, a waiter
  // hitting an admin path). Treating 403 as expiry bounced tablets straight
  // back to the PIN screen with no error, because AppLayout always fetches
  // /billing/status and /notifications after login.
  function maybeForceLogout(
    status: number,
    token: string | null,
    requestGeneration: number,
    path: string,
  ) {
    if (
      shouldForceLogoutOn401(
        status,
        token,
        getToken(),
        {
          request: requestGeneration,
          current: lanAuthGeneration(),
        },
        path,
      )
    ) {
      forceLogout('unauthorized');
    }
  }

  function lanRequestTimeoutMs(path: string, method: string): number {
    const pathname = String(path || '').split('?')[0];
    if (pathname === '/auth/login' || pathname === '/pairing/verify') {
      return IS_NATIVE_SHELL ? 12_000 : 6_000;
    }
    if (pathname.startsWith('/admin/updates/')) {
      // Check/download start work on the till and return; still allow GitHub
      // a few seconds. Install may drop the socket when POS restarts.
      return 15_000;
    }
    if (path.includes('/print')) return LAN_PRINT_TIMEOUT_MS;
    if (method === 'GET' || method === 'HEAD') return CLIENT_GET_TIMEOUT_MS;
    return CLIENT_TIMEOUT_MS;
  }

  function lanRequestAttempts(path: string, method: string): number {
    const pathname = String(path || '').split('?')[0];
    if (pathname === '/auth/login' || pathname === '/pairing/verify') return 1;
    if (method === 'GET' || method === 'HEAD') return readRetryAttempts();
    return 2;
  }

  function lanBasesForPath(path: string): string[] {
    const pathname = String(path || '').split('?')[0];
    const all = lanBases(getHttpBase(), getHttpsBase());
    if (pathname === '/auth/login' || pathname === '/pairing/verify') {
      if (getPreferredScheme() === 'https') return all;
      return [getHttpBase()];
    }
    return all;
  }

  // Always call the host LAN API (even when cloud mode is enabled).
  async function goLan(path: string, opts?: RequestInit) {
    const token = tokenForLanPath(path);
    const requestGeneration = lanAuthGeneration();
    const method = String(opts?.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(IS_NATIVE_SHELL
        ? { 'X-POS-Client': 'native' }
        : (window as any).__ADMIN_APP__
          ? { 'X-POS-Client': 'admin' }
          : (window as any).__KDS_APP__
            ? { 'X-POS-Client': 'kds' }
            : {}),
      ...(((opts?.headers as any) || {}) as any),
    };
    const timeoutMs = lanRequestTimeoutMs(path, method);
    const attempts = lanRequestAttempts(path, method);
    const bases = lanBasesForPath(path);

    const run = async (base: string) => {
      const r = await fetchWithRetry(
        base + path,
        { ...opts, headers },
        attempts,
        timeoutMs,
      );
      if (!r.ok) {
        maybeForceLogout(r.status, token, requestGeneration, path);
        const { message, code, permanent } = await readErrorMessage(r);
        throw new HttpError(r.status, message, code, permanent);
      }
      if (base.startsWith('https:')) setPreferredScheme('https');
      else setPreferredScheme('http');
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    };

    const execute = async () => {
      let lastErr: any = null;
      for (let i = 0; i < bases.length; i++) {
        try {
          return await run(bases[i]);
        } catch (e: any) {
          lastErr = e;
          if (!isRetryableNetworkError(e)) throw e;
          // Once HTTP is known to work, a timeout is congestion — not a
          // reason to wait a second HTTPS handshake on the same slow link.
          if (getPreferredScheme() === 'http') throw e;
        }
      }
      throw lastErr;
    };

    if (method === 'GET' || method === 'HEAD') {
      return dedupe(lanDedupeKey(method, path, token), execute);
    }
    return execute();
  }

  (window as any).api = {
    auth: {
      async loginWithPin(pin: string, userId?: number, pairingCode?: string) {
        // One POST: the host already enforces pairing on /auth/login.
        // A preflight /pairing/verify doubled wait on slow Wi-Fi.
        try {
          const resp = await goLan('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ pin, userId, pairingCode }),
          });
          if (resp && typeof resp === 'object' && 'token' in resp) {
            const t = (resp as any).token;
            if (typeof t === 'string' && t.length > 10) setToken(t);
            startSse();
            return (resp as any).user ?? null;
          }
          if (resp == null) return null;
          throw new Error(
            typeof resp === 'string' && resp.trim()
              ? resp.trim()
              : 'Login failed',
          );
        } catch (e) {
          if (isPairingRejectedError(e)) {
            throw new Error('Pairing code required');
          }
          throw e;
        }
      },
      async verifyManagerPin(pin: string) {
        const r = await goLan('/auth/verify-manager-pin', {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
        return r && typeof r === 'object' ? r : { ok: false };
      },
      async createUser(input: any) {
        return await goLan('/auth/create-user', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
      async logoutAdmin() {
        return true;
      },
      // The IPC session registry is an Electron-only concept: LAN clients
      // authenticate every request with their own bearer token. `null` here
      // would read as "your session is gone", so these are inert.
      async resumeSession() {
        return null;
      },
      async endSession() {
        return true;
      },
      async listUsers(_input?: { includeAdmins?: boolean }) {
        if ((window as any).__ADMIN_APP__) {
          const token = getToken();
          if (token && isHostOrAdminRole(jwtRole(token))) {
            return await goLan('/admin/users');
          }
        }
        return await goLan('/auth/users');
      },
      async updateUser(input: any) {
        return await goLan('/auth/update-user', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
      async syncStaffFromApi() {
        throw new Error('not supported in browser');
      },
      async deleteUser(input: any) {
        return await goLan('/auth/delete-user', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
    },
    menu: {
      async listCategoriesWithItems() {
        return await goLan('/menu/categories');
      },
      async createCategory(input: any) {
        return await goLan('/menu/create-category', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
      async updateCategory(input: any) {
        return await goLan('/menu/update-category', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
      async deleteCategory(id: number) {
        return await goLan('/menu/delete-category', {
          method: 'POST',
          body: JSON.stringify({ id }),
        });
      },
      async createItem(input: any) {
        return await goLan('/menu/create-item', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
      async updateItem(input: any) {
        return await goLan('/menu/update-item', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
      async deleteItem(id: number) {
        return await goLan('/menu/delete-item', {
          method: 'POST',
          body: JSON.stringify({ id }),
        });
      },
    },
    settings: {
      async get() {
        return await goLan('/settings');
      },
      async update(input: any) {
        return await goLan('/settings/update', {
          method: 'POST',
          body: JSON.stringify(input),
        });
      },
      async testPrint() {
        const r = await goLan('/print/test', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const ok = !!(r && r.ok === true);
        if (!ok) {
          const err =
            r && (r.error || r.message) ? String(r.error || r.message) : '';
          window.dispatchEvent(
            new CustomEvent('printer:event', {
              detail: {
                level: 'error',
                kind: 'TEST',
                message:
                  'Printer test failed. Check power/paper and the IP/port settings.',
                detail: err || undefined,
                at: Date.now(),
              },
            }),
          );
        }
        return ok;
      },
      async testPrintProfile(profile: any) {
        return await goLan('/print/test-profile', {
          method: 'POST',
          body: JSON.stringify({ profile }),
        });
      },
      async scanNetworkPrinters() {
        const rows = await goLan('/print/scan-network', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return Array.isArray(rows) ? rows : [];
      },
      async setPrinter() {
        throw new Error('not supported in browser');
      },
      async listPrinters() {
        const rows = await goLan('/print/list');
        return Array.isArray(rows) ? rows : [];
      },
      async listSerialPorts() {
        const rows = await goLan('/print/serial-ports');
        return Array.isArray(rows) ? rows : [];
      },
      async getFiscalTokenHint() {
        return await goLan('/settings/fiscal-token-hint');
      },
      async testFiscalConnection() {
        return await goLan('/settings/fiscal-test', { method: 'POST' });
      },
      async testFiscalMinimalInvoice() {
        return await goLan('/settings/fiscal-test-minimal', { method: 'POST' });
      },
      async listFiscalReviews() {
        const rows = await goLan('/settings/fiscal-reviews');
        return Array.isArray(rows) ? rows : [];
      },
      async resolveFiscalReview(input: any) {
        return await goLan('/settings/fiscal-reviews', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
    },
    license: {
      async getStatus() {
        return {
          required: false,
          licensed: true,
          billingConfigured: false,
        };
      },
      async createCheckout() {
        return { error: 'Licensing is managed on the POS host' };
      },
      async activateSession() {
        return { ok: false, error: 'Licensing is managed on the POS host' };
      },
      async activateKey() {
        return { ok: false, error: 'Licensing is managed on the POS host' };
      },
      async restore() {
        return { ok: false, error: 'Licensing is managed on the POS host' };
      },
      async createPortalSession() {
        return { error: 'Licensing is managed on the POS host' };
      },
    },
    billing: {
      async getStatus() {
        try {
          return await goLan('/billing/status');
        } catch (e: any) {
          return {
            billingEnabled: false,
            status: 'ACTIVE',
            message: String(e?.message || e || ''),
          };
        }
      },
      async getStatusLive() {
        try {
          return await goLan('/billing/status?live=1');
        } catch (e: any) {
          return {
            billingEnabled: false,
            status: 'ACTIVE',
            message: String(e?.message || e || ''),
          };
        }
      },
      async createCheckoutSession() {
        try {
          return await goLan('/admin/billing/create-checkout', {
            method: 'POST',
            body: JSON.stringify({}),
          });
        } catch (e: any) {
          return {
            error: String(e?.message || 'Could not create checkout session'),
          };
        }
      },
      async createPortalSession() {
        try {
          return await goLan('/admin/billing/create-portal', {
            method: 'POST',
            body: JSON.stringify({}),
          });
        } catch (e: any) {
          return {
            error: String(e?.message || 'Could not create portal session'),
          };
        }
      },
    },
    system: {
      async openExternal(url: string) {
        try {
          const u = String(url || '').trim();
          if (!u) return false;
          window.open(u, '_blank', 'noopener,noreferrer');
          return true;
        } catch {
          return false;
        }
      },
    },
    shifts: {
      async getOpen(userId: number) {
        return await goLan(
          `/shifts/get-open?userId=${encodeURIComponent(String(userId))}`,
        );
      },
      async clockIn(userId: number) {
        return await goLan('/shifts/clock-in', {
          method: 'POST',
          body: JSON.stringify({ userId }),
        });
      },
      async clockOut(userId: number) {
        return await goLan('/shifts/clock-out', {
          method: 'POST',
          body: JSON.stringify({ userId }),
        });
      },
      // Use LAN proxy so login screen can show "clocked in" even before the tablet is logged in.
      async listOpen() {
        return await goLan('/shifts/open');
      },
    },
    tickets: {
      async log(input: any) {
        const r = await goLan('/tickets', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        if (r && typeof r === 'object') {
          if (r.ok === false) return r;
          if (r.ok === true) return r;
        }
        return { ok: true };
      },
      async getLatestForTable(area: string, tableLabel: string) {
        return await goLan(
          `/tickets/latest?area=${encodeURIComponent(area)}&table=${encodeURIComponent(tableLabel)}`,
        );
      },
      async voidItem(input: any) {
        await goLan('/tickets/void-item', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        return true;
      },
      async voidTicket(input: any) {
        await goLan('/tickets/void-ticket', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        return true;
      },
      async getTableTooltip(area: string, tableLabel: string) {
        return await goLan(
          `/tickets/tooltip?area=${encodeURIComponent(area)}&table=${encodeURIComponent(tableLabel)}`,
        );
      },
      async listPaidTables(input: { dateIso: string }) {
        const dateIso = encodeURIComponent(String(input?.dateIso || ''));
        return await goLan(`/tickets/paid-tables?dateIso=${dateIso}`);
      },
      async print(input: any) {
        const r = await goLan('/print/ticket', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        // Return the host body so fiscal `{ ok: false, code, permanent }`
        // is not collapsed to a bare `false` (that used to look like a
        // printer hiccup and close the table).
        if (r && typeof r === 'object' && (r as any).ok === false) {
          return r;
        }
        const printed = r && typeof r === 'object' ? (r as any).printed : true;
        if (r && (r as any).ok === true && printed === false) {
          const isPay =
            String(input?.meta?.kind || '').toUpperCase() === 'PAYMENT';
          window.dispatchEvent(
            new CustomEvent('printer:event', {
              detail: {
                level: 'warn',
                kind: isPay ? 'receipt' : 'PRINT',
                message: isPay
                  ? 'Payment recorded. Receipt will print when the printer is back.'
                  : 'Order sent. Kitchen printer will retry.',
                at: Date.now(),
              },
            }),
          );
        }
        return r && typeof r === 'object' ? r : { ok: true };
      },
    },
    tables: {
      async setOpen(area: string, label: string, open: boolean) {
        await goLan('/tables/open', {
          method: 'POST',
          body: JSON.stringify({ area, label, open }),
        });
        return true;
      },
      async listOpen() {
        return await goLan('/tables/open');
      },
      async getFloorSnapshot(area?: string) {
        const path = area
          ? `/tables/floor-snapshot?area=${encodeURIComponent(String(area))}`
          : '/tables/floor-snapshot';
        return await goLan(path);
      },
      async transfer(input: any) {
        return await goLan('/tables/transfer', {
          method: 'POST',
          body: JSON.stringify(input),
        });
      },
    },
    covers: {
      async save(area: string, label: string, covers: number) {
        await goLan('/covers/save', {
          method: 'POST',
          body: JSON.stringify({ area, label, covers }),
        });
        return true;
      },
      async getLast(area: string, label: string) {
        return await goLan(
          `/covers/last?area=${encodeURIComponent(area)}&label=${encodeURIComponent(label)}`,
        );
      },
    },
    health: {
      async ping() {
        return await goLan('/health');
      },
    },
    network: {
      async getIps() {
        const rows = await goLan('/network/ips');
        return Array.isArray(rows) ? rows : [];
      },
    },
    backups: {
      async list() {
        const rows = await goLan('/backups');
        return Array.isArray(rows) ? rows : [];
      },
      async create() {
        return await goLan('/backups/create', {
          method: 'POST',
          body: JSON.stringify({}),
        });
      },
      async restore(input: { name: string }) {
        return await goLan('/backups/restore', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
    },
    vault: {
      async getStatus() {
        return await goLan('/vault/prefs');
      },
      async getPrefs() {
        return await goLan('/vault/prefs');
      },
      async setup() {
        return { ok: false, error: 'not supported in browser' };
      },
      async unlock() {
        return { ok: false, error: 'not supported in browser' };
      },
      async ackRecovery() {
        return { ok: true };
      },
      async setUnlockMode(input: {
        unlockMode: 'os' | 'passphrase';
        passphrase?: string;
      }) {
        return await goLan('/vault/prefs', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
    },
    hostUpdates: {
      getStatus: () => goLan('/admin/updates/status'),
      check: () => goLan('/admin/updates/check', { method: 'POST' }),
      download: () => goLan('/admin/updates/download', { method: 'POST' }),
      install: () => goLan('/admin/updates/install', { method: 'POST' }),
    },
    admin: {
      async getOverview() {
        return await goLan('/admin/overview');
      },
      async listShifts(input?: any) {
        const q = new URLSearchParams();
        if (input?.startIso) q.set('startIso', String(input.startIso));
        if (input?.endIso) q.set('endIso', String(input.endIso));
        const suffix = q.toString() ? `?${q.toString()}` : '';
        return await goLan('/admin/shifts' + suffix);
      },
      async listTicketCounts(input?: { startIso?: string; endIso?: string }) {
        const q = new URLSearchParams();
        if (input?.startIso) q.set('startIso', String(input.startIso));
        if (input?.endIso) q.set('endIso', String(input.endIso));
        const suffix = q.toString() ? `?${q.toString()}` : '';
        const rows = await goLan('/admin/ticket-counts' + suffix);
        return Array.isArray(rows) ? rows : [];
      },
      async listTicketsByUser(
        userId: number,
        range?: { startIso?: string; endIso?: string },
      ) {
        const q = new URLSearchParams();
        q.set('userId', String(userId));
        if (range?.startIso) q.set('startIso', String(range.startIso));
        if (range?.endIso) q.set('endIso', String(range.endIso));
        const rows = await goLan(`/admin/tickets-by-user?${q.toString()}`);
        return Array.isArray(rows) ? rows : [];
      },
      async listNotifications(input?: any) {
        const q = new URLSearchParams();
        if (input?.onlyUnread) q.set('onlyUnread', '1');
        if (input?.limit) q.set('limit', String(input.limit));
        const suffix = q.toString() ? `?${q.toString()}` : '';
        const rows = await goLan('/notifications' + suffix);
        return Array.isArray(rows) ? rows : [];
      },
      async markAllNotificationsRead() {
        await goLan('/notifications/mark-all-read', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return true;
      },
      async getTopSellingToday() {
        return await goLan('/admin/top-selling-today');
      },
      async getSalesTrends(input: any) {
        const range = input?.range || 'daily';
        return await goLan(
          `/admin/sales-trends?range=${encodeURIComponent(range)}`,
        );
      },
      async getReview(input: any) {
        return await goLan('/admin/review', {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        });
      },
    },
    kds: {
      async openWindow() {
        return false;
      },
      async listTickets(input: any) {
        const station = String(input?.station || 'KITCHEN').toUpperCase();
        const status = String(input?.status || 'NEW').toUpperCase();
        const limit = Number(input?.limit || 100);
        const q = new URLSearchParams({
          station,
          status,
          limit: String(limit),
        });
        if (input?.cooker) q.set('cooker', '1');
        return await goLan(`/kds/tickets?${q.toString()}`);
      },
      async listFloorOrders() {
        const rows = await goLan('/kds/floor-orders');
        return Array.isArray(rows) ? rows : [];
      },
      async bump(input: any) {
        const station = String(input?.station || 'KITCHEN').toUpperCase();
        const ticketId = Number(input?.ticketId || 0);
        const r = await goLan('/kds/bump', {
          method: 'POST',
          body: JSON.stringify({
            station,
            ticketId,
            cooker: Boolean(input?.cooker),
          }),
        });
        return Boolean((r as any)?.ok ?? true);
      },
      async recall(input: any) {
        const station = String(input?.station || 'KITCHEN').toUpperCase();
        const ticketId =
          input?.ticketId != null ? Number(input.ticketId) : undefined;
        const itemIdx =
          input?.itemIdx != null ? Number(input.itemIdx) : undefined;
        const body: Record<string, unknown> = { station };
        if (ticketId) body.ticketId = ticketId;
        if (itemIdx != null && Number.isFinite(itemIdx)) body.itemIdx = itemIdx;
        if (input?.cooker) body.cooker = true;
        const r = await goLan('/kds/recall', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          ok: Boolean((r as any)?.ok),
          ticketId: (r as any)?.ticketId ?? null,
          itemRecalled: Boolean((r as any)?.itemRecalled),
        };
      },
      async clearDone(input: any) {
        const station = String(input?.station || 'KITCHEN').toUpperCase();
        const r = await goLan('/kds/clear-done', {
          method: 'POST',
          body: JSON.stringify({ station }),
        });
        return {
          ok: Boolean((r as any)?.ok),
          purgedDoneRows: Number((r as any)?.purgedDoneRows || 0),
        };
      },
      async bumpItem(input: any) {
        const station = String(input?.station || 'KITCHEN').toUpperCase();
        const ticketId = Number(input?.ticketId || 0);
        const itemIdx = Number(input?.itemIdx ?? input?.idx ?? -1);
        const r = await goLan('/kds/bump-item', {
          method: 'POST',
          body: JSON.stringify({
            station,
            ticketId,
            itemIdx,
            cooker: Boolean(input?.cooker),
          }),
        });
        return Boolean((r as any)?.ok ?? true);
      },
      async getTicketDetail(input: any) {
        const ticketId = Number(input?.ticketId || 0);
        if (!ticketId) return null;
        const q = new URLSearchParams({ ticketId: String(ticketId) });
        return await goLan(`/kds/ticket-detail?${q.toString()}`);
      },
      async getCookerMode() {
        const r = await goLan('/kds/cooker-mode');
        return { enabled: Boolean((r as any)?.enabled) };
      },
      async getEnabledStations() {
        const r = await goLan('/kds/enabled-stations');
        const stations = Array.isArray((r as any)?.stations)
          ? (r as any).stations
          : [];
        return {
          enabled: (r as any)?.enabled !== false,
          stations,
        };
      },
      async setCookerMode(input: any) {
        const r = await goLan('/kds/cooker-mode', {
          method: 'POST',
          body: JSON.stringify({ enabled: Boolean(input?.enabled) }),
        });
        return {
          ok: Boolean((r as any)?.ok),
          enabled: Boolean((r as any)?.enabled),
          error: (r as any)?.error,
        };
      },
      debug() {
        return goLan('/kds/debug');
      },
    },
    reports: {
      async getMyOverview(_userId: number) {
        return await goLan('/reports/my/overview');
      },
      async getMyTopSellingToday(_userId: number) {
        return await goLan('/reports/my/top-selling-today');
      },
      async getMySalesTrends(input: any) {
        const range = String(input?.range || 'daily');
        return await goLan(
          `/reports/my/sales-trends?range=${encodeURIComponent(range)}`,
        );
      },
      async listMyActiveTickets(_userId: number) {
        return await goLan('/reports/my/active-tickets');
      },
      async listMyPaidTickets(input: any) {
        const q = String(input?.q || '').trim();
        const limit = Number(input?.limit || 40);
        const qs = new URLSearchParams();
        if (q) qs.set('q', q);
        if (Number.isFinite(limit) && limit > 0) qs.set('limit', String(limit));
        return await goLan(`/reports/my/paid-tickets?${qs.toString()}`);
      },
      async listMyVoidedTickets(input: any) {
        const limit = Number(input?.limit || 40);
        return await goLan(`/reports/my/voided-tickets?limit=${limit}`);
      },
    },
    offline: {
      async getStatus() {
        // Always ask the host LAN API for outbox status.
        return await goLan('/offline/status').catch(() => ({ queued: 0 }));
      },
    },
    layout: {
      async get(userId: number, area: string, scope?: string) {
        const q = new URLSearchParams({
          userId: String(userId),
          area: String(area),
        });
        if (scope) q.set('scope', String(scope));
        return await goLan(`/layout/get?${q.toString()}`);
      },
      async save(userId: number, area: string, nodes: any[], scope?: string) {
        await goLan('/layout/save', {
          method: 'POST',
          body: JSON.stringify({
            userId,
            area,
            nodes,
            ...(scope ? { scope } : {}),
          }),
        });
        return true;
      },
      async getMerges(area: string) {
        const q = new URLSearchParams({ area: String(area) });
        return await goLan(`/reservations/merges?${q.toString()}`);
      },
      async setMerges(area: string, groups: any[]) {
        return await goLan('/reservations/merges', {
          method: 'POST',
          body: JSON.stringify({ area, groups }),
        });
      },
    },
    notifications: {
      async list(userId: number, onlyUnread?: boolean) {
        void userId;
        const q = new URLSearchParams();
        if (onlyUnread) q.set('onlyUnread', '1');
        return await goLan(`/notifications?${q.toString()}`);
      },
      async markAllRead(userId: number) {
        void userId;
        await goLan('/notifications/mark-all-read', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return true;
      },
    },
    reservations: {
      // No window concept in the mobile shell; the panel is a route in the
      // same SPA, so callers use react-router to navigate to /reservations.
      // Returning false makes the LoginPage fall back to a navigate() call.
      async openWindow() {
        return false;
      },
      async list(input: any) {
        const dateIso = String(input?.dateIso || '');
        const area = input?.area ? String(input.area) : '';
        const q = new URLSearchParams({ dateIso });
        if (area) q.set('area', area);
        return await goLan(`/reservations?${q.toString()}`);
      },
      async listCounts(input: any) {
        const startIso = String(input?.startIso || '');
        const endIso = String(input?.endIso || '');
        const q = new URLSearchParams({ startIso, endIso });
        return await goLan(`/reservations/counts?${q.toString()}`);
      },
      async create(input: any) {
        // The HTTP route always uses the authenticated user as `createdById`
        // (it ignores any client-supplied id), so we don't need to send one.
        return await goLan('/reservations', {
          method: 'POST',
          body: JSON.stringify(input || {}),
        });
      },
      async update(input: any) {
        return await goLan('/reservations/update', {
          method: 'POST',
          body: JSON.stringify(input || {}),
        });
      },
      async setStatus(input: any) {
        return await goLan('/reservations/set-status', {
          method: 'POST',
          body: JSON.stringify(input || {}),
        });
      },
      async delete(input: any) {
        const r: any = await goLan('/reservations/delete', {
          method: 'POST',
          body: JSON.stringify(input || {}),
        });
        return Boolean(r?.ok ?? true);
      },
    },
    requests: {
      create: async (input: any) =>
        goLan('/requests/create', {
          method: 'POST',
          body: JSON.stringify(input),
        }).then(() => true),
      listForOwner: async (ownerId: number) =>
        goLan(
          `/requests/list-for-owner?ownerId=${encodeURIComponent(String(ownerId))}`,
        ),
      approve: async (id: number, ownerId: number) =>
        goLan('/requests/approve', {
          method: 'POST',
          body: JSON.stringify({ id, ownerId }),
        }).then(() => true),
      reject: async (id: number, ownerId: number) =>
        goLan('/requests/reject', {
          method: 'POST',
          body: JSON.stringify({ id, ownerId }),
        }).then(() => true),
      pollApprovedForTable: async (
        ownerId: number,
        area: string,
        tableLabel: string,
      ) =>
        goLan(
          `/requests/poll-approved?ownerId=${encodeURIComponent(String(ownerId))}&area=${encodeURIComponent(area)}&tableLabel=${encodeURIComponent(tableLabel)}`,
        ),
      markApplied: async (ids: number[]) =>
        goLan('/requests/mark-applied', {
          method: 'POST',
          body: JSON.stringify({ ids }),
        }).then(() => true),
    },
  };
  (window as any).__BROWSER_CLIENT__ = true;
}
