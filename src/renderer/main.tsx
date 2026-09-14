import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import { routes } from './routes';
import './styles/index.css';
import { offlineQueue } from './utils/offlineQueue';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { useReservationSessionStore } from './stores/reservationSession';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  PosServerScanHost,
  PosServerScanPanel,
} from './app/components/PosServerScan';
import { initMobileShell, hideMobileSplash } from './utils/mobileShell';
import { resumeMainProcessSession } from './utils/resumeSession';
import './i18n/config';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n from './i18n/config';
import { LocaleSync } from './i18n/LocaleSync';
import { ThemeSync } from './i18n/ThemeSync';
import { bootPosUiTheme } from './theme';
import { PageSpinner } from './components/PageSpinner';
import { useLicenseCapabilities } from './stores/licenseCapabilities';
import { readStoredFlag, writeStoredFlag } from './utils/storedFlag';
import {
  getHttpBase,
  getHttpsBase,
  hasConfiguredBackendHost,
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
  installPosReadCache,
  peekSettings,
  emitPosSyncCatchup,
  emitPosSyncCatchupSoon,
} from './utils/posReadCache';
import { installPosRealtimeSync } from './utils/posRealtimeSync';
import { installRemoteAppUpdateListener } from './utils/remoteAppUpdate';
import { installWakeUiRecovery } from './utils/wakeUiRecovery';
import { installUnhandledErrorToasts } from './utils/reportAppError';
import { initRendererSentry } from './utils/sentryBrowser';
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
import {
  SHIFT_GUARD_GRACE_MS,
  isPersistedSessionExpired,
  sessionShellFromHash,
} from './stores/sessionPersist';
import {
  HOST_VERSION_STORAGE_KEY,
  isHostRendererHref,
  planHostVersionSync,
} from './utils/hostVersionSync';

async function syncTabletToHostVersion(): Promise<void> {
  const ping = (window as any).api?.health?.ping;
  if (typeof ping !== 'function') return;
  try {
    const h = await ping();
    const next = String(h?.appVersion || '').trim();
    if (!next) return;
    let previous: string | null = null;
    try {
      previous = localStorage.getItem(HOST_VERSION_STORAGE_KEY);
    } catch {
      previous = null;
    }
    const plan = planHostVersionSync({
      previous,
      next,
      servedFromHostRenderer: isHostRendererHref(
        String(window.location.href || ''),
      ),
    });
    if (plan.persist) {
      try {
        localStorage.setItem(HOST_VERSION_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
    if (plan.invalidate) emitPosSyncCatchup();
    if (plan.reload) window.location.reload();
  } catch {
    // host unreachable — next visibility / SSE open retries
  }
}
// PWA registration disabled for desktop build

void initMobileShell();
if (!(window as any).__KDS_APP__) bootPosUiTheme();

// Polyfill window.api for browser (tablets) by calling the LAN HTTP API
// When running inside Electron, preload already defines window.api
if (!(window as any).api) {
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
  /** Tablets on LAN Wi‑Fi often need more than 5s; desktops stay snappy. */
  const CLIENT_TIMEOUT_MS = IS_NATIVE_SHELL ? 8_000 : 4_000;
  const CLIENT_GET_TIMEOUT_MS = IS_NATIVE_SHELL ? 5_000 : 3_000;
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

  async function fetchWithTimeout(
    input: RequestInfo | URL,
    init?: RequestInit,
    timeoutMs = CLIENT_TIMEOUT_MS,
  ) {
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

  const startSse = () => {
    try {
      // Keep this callable so boot / login can restart SSE without crashing.
      const token = getToken();
      if (!token) {
        // No session yet — close any zombie connection and wait for login
        // to call us again.
        stopSse();
        return;
      }
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
      const url =
        `${getHttpBase()}/events?token=${encodeURIComponent(token)}` +
        (IS_NATIVE_SHELL ? '&client=native' : '');
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
        // The browser's built-in retry is opaque and inconsistent across
        // platforms (especially Android WebView). Drop the socket and
        // reschedule with our own backoff so we always recover.
        const state = es?.readyState;
        if (state === 2 /* CLOSED */ || !es) {
          stopSse();
          scheduleSseReconnect();
          return;
        }
        // CONNECTING: let the browser try once; if it still hasn't reopened
        // by the next health tick, the watchdog will force a reconnect.
      });

      es.addEventListener('ping', () => {
        lastSseEventAt = Date.now();
        noteSseEvent();
      });
      es.addEventListener('tables', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const { area, label, open } = data || {};
          if (area && label && typeof open === 'boolean') {
            const store = (window as any).__tableStatusStore__;
            if (store && store.setOpen) store.setOpen(area, label, open);
          }
          handleSseEvent('pos:tablesChanged', data);
        } catch (e) {
          void e;
          emitPosSyncCatchupSoon();
        }
      });
      // Reservations: a HOST/ADMIN on another device created/edited/cancelled
      // a booking. Re-emit as a window event so the Floor and List pages can
      // refetch their visible day without us having to import their stores
      // here. Payload mirrors `ReservationChangePayload` from the service.
      es.addEventListener('reservations', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:reservationsChanged', data);
        } catch (e) {
          void e;
          emitPosSyncCatchupSoon();
        }
      });
      // Tickets: another waiter just appended an item to a table. The
      // TablesPage uses this to re-fetch the per-table waiter badge so
      // every device shows the actual waiter who wrote the latest order
      // (without waiting for the next 5s poll). Payload mirrors
      // `TicketChangePayload` from the service.
      es.addEventListener('ticket', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:ticketsChanged', data);
        } catch (e) {
          void e;
          emitPosSyncCatchupSoon();
        }
      });
      // Floor layout: admin re-published the shared layout for an area.
      es.addEventListener('layout', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:layoutChanged', data);
        } catch (e) {
          void e;
          emitPosSyncCatchupSoon();
        }
      });
      es.addEventListener('tableMerges', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:tableMergesChanged', data);
        } catch (e) {
          void e;
          emitPosSyncCatchupSoon();
        }
      });
      es.addEventListener('settings', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:settingsChanged', data);
        } catch (e) {
          void e;
          emitPosSyncCatchupSoon();
        }
      });
      es.addEventListener('apps-update', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:appsUpdate', data);
        } catch (e) {
          void e;
        }
      });
      es.addEventListener('catchup', () => {
        emitPosSyncCatchup();
      });

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
    const token = getToken();
    if (!token) return;
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
  ) {
    if (
      shouldForceLogoutOn401(status, token, getToken(), {
        request: requestGeneration,
        current: lanAuthGeneration(),
      })
    ) {
      forceLogout('Session expired');
    }
  }

  function lanRequestTimeoutMs(path: string, method: string): number {
    const pathname = String(path || '').split('?')[0];
    if (pathname === '/auth/login' || pathname === '/pairing/verify') {
      return IS_NATIVE_SHELL ? 12_000 : 6_000;
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
      ...(IS_NATIVE_SHELL ? { 'X-POS-Client': 'native' } : {}),
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
        maybeForceLogout(r.status, token, requestGeneration);
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
      async setPrinter() {
        throw new Error('not supported in browser');
      },
      async listPrinters() {
        return [];
      },
      async listSerialPorts() {
        return [];
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
        return [];
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
      async listTicketCounts() {
        throw new Error('not supported in browser');
      },
      async listTicketsByUser() {
        throw new Error('not supported in browser');
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

installPosReadCache();
installPosRealtimeSync();
installRemoteAppUpdateListener();

// Standalone KDS / Admin: bridge auto-updater IPC exposed by preload.
{
  const companionUpdater =
    ((window as any).__KDS_APP__ && (window as any).kdsApp?.updater) ||
    ((window as any).__ADMIN_APP__ && (window as any).adminApp?.updater);
  if (companionUpdater) {
    (window as any).api = {
      ...((window as any).api || {}),
      updater: companionUpdater,
    };
  }
}

const router = createHashRouter(routes);

const LicenseGate = React.lazy(() => import('./app/components/LicenseGate'));
const UpdateNotification = React.lazy(() =>
  import('./components/UpdateNotification').then((m) => ({
    default: m.UpdateNotification,
  })),
);
const Toaster = React.lazy(() =>
  import('./components/Toaster').then((m) => ({ default: m.Toaster })),
);

const LICENSE_OK_KEY = 'pos-license-ok';

function isElectronLicenseHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).api?.license) &&
    !(window as any).__BROWSER_CLIENT__ &&
    !(window as any).__KDS_APP__ &&
    !(window as any).__ADMIN_APP__
  );
}

function MaybeLicenseGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const host = isElectronLicenseHost();
  const [blocked, setBlocked] = useState(
    () => host && !readStoredFlag(LICENSE_OK_KEY, true),
  );

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void window.api.license
      .getStatus()
      .then((s) => {
        if (cancelled) return;
        const ok = !s?.required || Boolean(s?.licensed);
        writeStoredFlag(LICENSE_OK_KEY, ok);
        useLicenseCapabilities.getState().setEdition(s?.edition);
        setBlocked(!ok);
      })
      .catch(() => {
        if (!cancelled) useLicenseCapabilities.getState().setEdition(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!host || !blocked) return <>{children}</>;
  return (
    <React.Suspense fallback={<PageSpinner message={t('common.loading')} />}>
      <LicenseGate>{children}</LicenseGate>
    </React.Suspense>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function BootScreen({
  message,
  detail,
  showScan,
}: {
  message: string;
  detail?: string;
  showScan?: boolean;
}) {
  return (
    <PageSpinner
      message={message}
      detail={showScan ? undefined : detail}
      spinner={!showScan}
    >
      {showScan ? <PosServerScanPanel autoScan /> : null}
    </PageSpinner>
  );
}

function Root() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState(() => t('boot.starting'));
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const [hostEpoch, setHostEpoch] = useState(0);

  useEffect(() => {
    const onHost = () => setHostEpoch((n) => n + 1);
    window.addEventListener(POS_BACKEND_HOST_CHANGED, onHost);
    return () => window.removeEventListener(POS_BACKEND_HOST_CHANGED, onHost);
  }, []);

  useEffect(() => {
    if (ready || backendUnreachable) void hideMobileSplash();
  }, [ready, backendUnreachable]);

  useEffect(() => {
    const onForce = (ev: any) => {
      const reason = ev?.detail?.reason
        ? String(ev.detail.reason)
        : t('boot.sessionExpired');
      const shell = sessionShellFromHash(window?.location?.hash || '');
      // Clear only the session store that belongs to this window. POS, Admin,
      // and Reservations share one origin / localStorage; wiping all three
      // here is what kicked an admin PIN login back to the login screen
      // whenever a leftover waiter session expired.
      try {
        if (shell === 'admin') {
          useAdminSessionStore.getState().setUser(null as any);
        } else if (shell === 'reservations') {
          useReservationSessionStore.getState().setUser(null as any);
        } else {
          useSessionStore.getState().setUser(null);
        }
      } catch {
        // ignore
      }
      try {
        window.location.hash =
          shell === 'admin'
            ? '#/admin'
            : shell === 'reservations'
              ? '#/reservations'
              : '#/';
      } catch {
        // ignore
      }
      // Optional: show a short hint on boot screen (if it appears)
      setMsg(t('boot.loginAgain'));
      setDetail(reason);
    };
    window.addEventListener('pos:forceLogout', onForce as any);
    return () => window.removeEventListener('pos:forceLogout', onForce as any);
  }, [t]);

  useEffect(() => {
    // Session expiry for Electron (persisted zustand sessions).
    // Browser clients already rely on API token expiry; they will trigger pos:forceLogout on 401.
    const tick = () => {
      if (!useSessionStore.getState().hasHydrated) return;
      const shell = sessionShellFromHash(window?.location?.hash || '');
      const now = Date.now();
      const staff = useSessionStore.getState() as any;
      const admin = useAdminSessionStore.getState() as any;
      const reservations = useReservationSessionStore.getState() as any;
      const staffGraceUntil =
        typeof staff?.authenticatedAt === 'number' && staff.authenticatedAt > 0
          ? staff.authenticatedAt + SHIFT_GUARD_GRACE_MS
          : undefined;
      const expired =
        shell === 'admin'
          ? isPersistedSessionExpired({
              user: admin?.user,
              expiresAtMs: admin?.expiresAtMs,
              now,
            })
          : shell === 'reservations'
            ? isPersistedSessionExpired({
                user: reservations?.user,
                expiresAtMs: reservations?.expiresAtMs,
                now,
              })
            : isPersistedSessionExpired({
                user: staff?.user,
                expiresAtMs: staff?.expiresAtMs,
                now,
                graceUntilMs: staffGraceUntil,
              });
      if (!expired) return;
      try {
        window.dispatchEvent(
          new CustomEvent('pos:forceLogout', {
            detail: { reason: t('boot.sessionExpired') },
          }),
        );
      } catch {
        // ignore
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const isKdsApp = Boolean((window as any).__KDS_APP__);
      const isAdminApp = Boolean((window as any).__ADMIN_APP__);
      const isCompanionApp = isKdsApp || isAdminApp;
      const hash = String(window.location.hash || '');
      const onCompanionSetup =
        (isKdsApp && hash.startsWith('#/kds-setup')) ||
        (isAdminApp && hash.startsWith('#/admin-setup'));
      if (onCompanionSetup) {
        setReady(true);
        return;
      }

      setReady(false);
      setBackendUnreachable(false);
      setMsg(t('boot.connecting'));
      setDetail(undefined);
      if (!isCompanionApp && !hasConfiguredBackendHost()) {
        setBackendUnreachable(true);
        setMsg(t('boot.cannotReach'));
        setDetail(t('boot.cannotReachDetail'));
        return;
      }
      const cachedSettings = !isCompanionApp ? peekSettings() : undefined;
      if (cachedSettings) {
        await resumeMainProcessSession().catch(() => {});
        if (cancelled) return;
        setReady(true);
        setBackendUnreachable(false);
        setMsg(t('boot.starting'));
        setDetail(undefined);
        void Promise.all([
          (window as any).api.settings.get().catch(() => null),
          (window as any).api.auth.listUsers().catch(() => null),
        ]).then(() => {
          if (!cancelled) offlineQueue.sync().catch(() => {});
        });
        void syncTabletToHostVersion();
        return;
      }
      const maxAttempts = 2;
      // One extra attempt, then stop so the user can Scan. No retry button.
      for (let attempt = 0; attempt < maxAttempts && !cancelled; attempt++) {
        try {
          // Android tablets (Samsung especially) often report navigator.onLine
          // false until the OS "validates" internet access — LAN-only setups
          // never satisfy that check, which blocks POS before fetch() runs.
          const capacitor =
            typeof window !== 'undefined' ? (window as any).Capacitor : null;
          const isNativeCaps =
            Boolean(capacitor?.isNativePlatform?.()) ||
            Boolean(
              capacitor?.getPlatform?.() && capacitor.getPlatform() !== 'web',
            );
          if (
            !isNativeCaps &&
            typeof navigator !== 'undefined' &&
            navigator.onLine === false
          ) {
            setMsg(t('boot.offline'));
            setDetail(t('boot.offlineDetail'));
            await sleep(750);
            continue;
          }
          // Minimal "backend is ready" checks. Companions probe the host;
          // the till needs settings. The staff directory loads on the login screen.
          if (isCompanionApp) {
            const companion = ((window as any).adminApp ||
              (window as any).kdsApp) as
              | {
                  testConnection?: (input: {
                    host: string;
                    httpPort: number;
                  }) => Promise<{ ok: boolean; error?: string }>;
                }
              | undefined;
            const backend = resolveBackendHost();
            if (companion?.testConnection) {
              const r = await companion.testConnection({
                host: backend.host,
                httpPort: Number(backend.httpPort) || 3333,
              });
              if (!r.ok) throw new Error(r.error || 'POS host unreachable');
            } else if (isKdsApp) {
              await (window as any).api.kds.debug();
            } else {
              await (window as any).api.health.ping();
            }
          } else {
            await (window as any).api.settings.get();
            void (window as any).api.auth.listUsers().catch(() => null);
            void syncTabletToHostVersion();
          }
          if (cancelled) return;
          // Hand the main process the token from our last login so it can
          // recognise the persisted session as one it issued. Without this the
          // privileged IPC channels stay closed after an app restart.
          await resumeMainProcessSession().catch(() => {});
          if (cancelled) return;
          setReady(true);
          setBackendUnreachable(false);
          setMsg(t('boot.starting'));
          setDetail(undefined);
          // After backend is confirmed, run offline sync (safe for Electron + browser)
          offlineQueue.sync().catch(() => {});
          return;
        } catch (e: any) {
          void e;
          if (attempt + 1 < maxAttempts && !cancelled) {
            await sleep(400);
          }
        }
      }
      if (!cancelled) {
        const isKdsApp = Boolean((window as any).__KDS_APP__);
        const isAdminApp = Boolean((window as any).__ADMIN_APP__);
        if (isKdsApp || isAdminApp) {
          try {
            window.location.hash = isAdminApp ? '#/admin-setup' : '#/kds-setup';
          } catch {
            // ignore
          }
          setReady(true);
          return;
        }
        setBackendUnreachable(true);
        setMsg(t('boot.cannotReach'));
        setDetail(t('boot.cannotReachDetail'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, hostEpoch]);

  useEffect(() => {
    if (!ready) return;
    void import('./app/AppLayout');
    void import('./app/pages/TablesPage');
  }, [ready]);

  if (!ready) {
    const lanClient =
      Boolean((window as any).__BROWSER_CLIENT__) ||
      Boolean((window as any).__KDS_APP__) ||
      Boolean((window as any).__ADMIN_APP__);
    const showScan = backendUnreachable && lanClient;
    return (
      <BootScreen
        message={msg}
        detail={showScan ? undefined : detail}
        showScan={showScan}
      />
    );
  }
  return (
    <>
      <RouterProvider router={router} />
      {(window as any).__KDS_APP__ || (window as any).__ADMIN_APP__ ? (
        <React.Suspense fallback={null}>
          <UpdateNotification />
        </React.Suspense>
      ) : null}
    </>
  );
}

if (typeof window !== 'undefined') {
  initRendererSentry();
  installWakeUiRecovery();
  installUnhandledErrorToasts();
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <LocaleSync>
        <ThemeSync>
          <ErrorBoundary>
            <MaybeLicenseGate>
              <Root />
            </MaybeLicenseGate>
            <PosServerScanHost />
            <React.Suspense fallback={null}>
              <Toaster />
            </React.Suspense>
          </ErrorBoundary>
        </ThemeSync>
      </LocaleSync>
    </I18nextProvider>
  </React.StrictMode>,
);
