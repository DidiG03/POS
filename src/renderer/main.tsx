import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import { routes } from './routes';
import './styles/index.css';
import { offlineQueue } from './utils/offlineQueue';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { useReservationSessionStore } from './stores/reservationSession';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/Toaster';
import { UpdateNotification } from './components/UpdateNotification';
import { PosHostPicker } from './app/components/PosHostPicker';
import { discoverPosHostsInBrowser } from './utils/discoverPosHosts';
import type { DiscoveredPosHost } from '@shared/posHostDiscovery';
import { initMobileShell } from './utils/mobileShell';
import { resumeMainProcessSession } from './utils/resumeSession';
import './i18n/config';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n from './i18n/config';
import { LocaleSync } from './i18n/LocaleSync';
import LicenseGate from './app/components/LicenseGate';
import {
  getHttpBase,
  getHttpsBase,
  persistKdsBackendHost,
  resolveBackendHost,
  syncBackendHostToLocalStorage,
} from './utils/backendHost';
import { isHostOrAdminRole, jwtRole } from '@shared/jwtRole';
// PWA registration disabled for desktop build

void initMobileShell();

// Initialize Sentry in renderer (if available via Electron preload)
// @sentry/electron automatically sets up renderer instrumentation when initialized in main process,
// but we expose it on window for ErrorBoundary to use
if (typeof window !== 'undefined') {
  try {
    // Check if Sentry is available (set by @sentry/electron in renderer)
    const Sentry = (window as any).__SENTRY__;
    if (Sentry && Sentry.getCurrentHub) {
      (window as any).__sentry__ = Sentry.getCurrentHub().getClient();
    }
  } catch {
    // Sentry not available (e.g., SENTRY_DSN not set) - this is fine
  }
}

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

  function readStoredToken(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStoredToken(key: string, t: string | null) {
    try {
      if (t) localStorage.setItem(key, t);
      else localStorage.removeItem(key);
    } catch {
      // ignore
    }
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
    } catch (e) {
      void e;
    }
  };

  function tokenForLanPath(path: string): string | null {
    const pathname = String(path || '').split('?')[0];
    if (
      pathname.startsWith('/layout/merges') ||
      pathname.startsWith('/reservations')
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
  const CLIENT_TIMEOUT_MS = IS_NATIVE_SHELL ? 12_000 : 5_000;
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
      });

      es.addEventListener('error', () => {
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
        }
      });
      // Floor layout: admin re-published the shared layout for an area.
      es.addEventListener('layout', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:layoutChanged', data);
        } catch (e) {
          void e;
        }
      });
      es.addEventListener('tableMerges', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          handleSseEvent('pos:tableMergesChanged', data);
        } catch (e) {
          void e;
        }
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
    window.addEventListener('beforeunload', stopSse);
    window.addEventListener('pagehide', stopSse);
    // Foreground / connectivity recovery: the three signals that reliably
    // fire when a real device wakes the WebView back up. Each one forces a
    // fresh SSE handshake so backgrounded tablets catch up the moment the
    // user looks at the panel again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ensureSse();
    });
    window.addEventListener('focus', () => ensureSse());
    window.addEventListener('online', () => ensureSse());
    // bfcache restore (iOS, modern Chromium) — `pageshow.persisted === true`
    // means the page was resurrected from cache with all timers paused.
    window.addEventListener('pageshow', (ev: any) => {
      if (ev && ev.persisted) ensureSse();
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
    for (let i = 0; i <= attempts; i++) {
      try {
        return await fetchWithTimeout(url, init, timeoutMs);
      } catch (e: any) {
        lastErr = e;
        if (!isRetryableNetworkError(e) || i === attempts) throw e;
        // small exponential backoff: 250ms, 500ms, 1000ms...
        const delay = Math.min(1500, 250 * Math.pow(2, i));
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
  function maybeForceLogout(status: number, token: string | null) {
    if (token && status === 401) forceLogout('Session expired');
  }

  function lanRequestTimeoutMs(path: string): number {
    return path.includes('/print') ? LAN_PRINT_TIMEOUT_MS : CLIENT_TIMEOUT_MS;
  }

  // Always call the host LAN API (even when cloud mode is enabled).
  async function goLan(path: string, opts?: RequestInit) {
    const token = tokenForLanPath(path);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(IS_NATIVE_SHELL ? { 'X-POS-Client': 'native' } : {}),
      ...(((opts?.headers as any) || {}) as any),
    };
    const timeoutMs = lanRequestTimeoutMs(path);
    // Prefer HTTP first to avoid self-signed cert warnings in browsers, then fallback to HTTPS
    try {
      const r = await fetchWithRetry(
        getHttpBase() + path,
        { ...opts, headers },
        2,
        timeoutMs,
      );
      if (!r.ok) {
        maybeForceLogout(r.status, token);
        const { message, code, permanent } = await readErrorMessage(r);
        throw new HttpError(r.status, message, code, permanent);
      }
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    } catch (e: any) {
      if (!isRetryableNetworkError(e)) throw e;
      const r2 = await fetchWithRetry(
        getHttpsBase() + path,
        { ...opts, headers },
        2,
        timeoutMs,
      );
      if (!r2.ok) {
        maybeForceLogout(r2.status, token);
        const { message, code, permanent } = await readErrorMessage(r2);
        throw new HttpError(r2.status, message, code, permanent);
      }
      const ct2 = r2.headers.get('content-type') || '';
      return ct2.includes('application/json') ? r2.json() : r2.text();
    }
  }

  (window as any).api = {
    auth: {
      async loginWithPin(pin: string, userId?: number, pairingCode?: string) {
        // Tablets are served from the host LAN API. Enforce host pairing code before any login.
        try {
          await goLan('/pairing/verify', {
            method: 'POST',
            body: JSON.stringify({ pairingCode }),
          });
        } catch {
          throw new Error('Pairing code required');
        }
        // Always go through host so it can proxy to cloud with correct userId translation
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
        return resp;
      },
      async verifyManagerPin(pin: string) {
        const r = await goLan('/auth/verify-manager-pin', {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
        return r && typeof r === 'object' ? r : { ok: false };
      },
      async createUser() {
        throw new Error('not supported in browser');
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
        // Always go through the LAN host for user listing.
        return await goLan('/auth/users');
      },
      async updateUser() {
        throw new Error('not supported in browser');
      },
      async syncStaffFromApi() {
        throw new Error('not supported in browser');
      },
      async deleteUser() {
        throw new Error('not supported in browser');
      },
    },
    menu: {
      async listCategoriesWithItems() {
        return await goLan('/menu/categories');
      },
      async createCategory() {
        throw new Error('not supported in browser');
      },
      async updateCategory() {
        throw new Error('not supported in browser');
      },
      async deleteCategory() {
        throw new Error('not supported in browser');
      },
      async createItem() {
        throw new Error('not supported in browser');
      },
      async updateItem() {
        throw new Error('not supported in browser');
      },
      async deleteItem() {
        throw new Error('not supported in browser');
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
        throw new Error('not supported in browser');
      },
      async listSerialPorts() {
        throw new Error('not supported in browser');
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
        const ok = !!(r && r.ok === true);
        if (!ok) {
          const err =
            r && (r.error || r.message) ? String(r.error || r.message) : '';
          window.dispatchEvent(
            new CustomEvent('printer:event', {
              detail: {
                level: 'error',
                kind: 'PRINT',
                message:
                  'Printer failed to print. Check paper/power and the IP/port settings.',
                detail: err || undefined,
                at: Date.now(),
              },
            }),
          );
        }
        return ok;
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
    admin: {
      async getOverview() {
        return await goLan('/admin/overview');
      },
      async openWindow() {
        return false;
      },
      async listShifts() {
        throw new Error('not supported in browser');
      },
      async listTicketCounts() {
        throw new Error('not supported in browser');
      },
      async listTicketsByUser() {
        throw new Error('not supported in browser');
      },
      async listNotifications() {
        throw new Error('not supported in browser');
      },
      async markAllNotificationsRead() {
        return false;
      },
      async getTopSellingToday() {
        throw new Error('not supported in browser');
      },
      async getSalesTrends(input: any) {
        const range = input?.range || 'daily';
        return await goLan(
          `/admin/sales-trends?range=${encodeURIComponent(range)}`,
        );
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

// Standalone KDS app: bridge auto-updater IPC exposed by preload.
if ((window as any).__KDS_APP__ && (window as any).kdsApp?.updater) {
  (window as any).api = {
    ...((window as any).api || {}),
    updater: (window as any).kdsApp.updater,
  };
}

const router = createHashRouter(routes);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function BootScreen({
  message,
  detail,
  canRetry,
  onRetry,
}: {
  message: string;
  detail?: string;
  canRetry?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const isKdsApp =
    typeof window !== 'undefined' && Boolean((window as any).__KDS_APP__);
  const showLanSetup = isBrowser || isKdsApp;
  const [showSetup, setShowSetup] = useState(false);
  const [setupNonce, setSetupNonce] = useState(0);
  const backend = useMemo(() => resolveBackendHost(), [setupNonce]);

  useEffect(() => {
    if (canRetry && showLanSetup) setShowSetup(true);
  }, [canRetry, showLanSetup]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-gray-100 px-6">
      <div className="flex flex-col items-center gap-4 w-full max-w-md">
        <svg
          className="w-7 h-7 animate-spin text-indigo-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        <div className="text-sm text-gray-300 text-center">{message}</div>
        {detail && (
          <div className="text-xs text-gray-500 text-center">{detail}</div>
        )}
        {showLanSetup && (
          <div className="text-xs text-gray-500 text-center">
            {t('boot.backendLabel')}
            <span className="font-mono">
              {backend.host}:{backend.httpPort}
            </span>
          </div>
        )}
        {(canRetry || showLanSetup) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 justify-center">
            {canRetry && onRetry && (
              <button
                className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                onClick={onRetry}
              >
                {t('common.retry')}
              </button>
            )}
            {showLanSetup && (
              <button
                className="px-4 py-2 rounded bg-indigo-700 hover:bg-indigo-600 text-sm"
                onClick={() => {
                  if (isKdsApp) {
                    try {
                      window.location.hash = '#/kds-setup';
                    } catch {
                      setShowSetup(true);
                    }
                    return;
                  }
                  setShowSetup(true);
                }}
                type="button"
              >
                {t('boot.configureServer')}
              </button>
            )}
          </div>
        )}
      </div>
      {showSetup && (
        <BackendSetupModal
          initial={backend}
          onClose={() => setShowSetup(false)}
          onSaved={() => {
            // Reload so api.ts / goLan picks up the new host. This is the
            // simplest correct path — nothing in the renderer caches the
            // backend across config changes.
            try {
              setSetupNonce((n) => n + 1);
              window.location.reload();
            } catch {
              // ignore
            }
          }}
        />
      )}
    </div>
  );
}

// Lightweight first-run / recovery panel for waiter phones.
// Lets the user set the LAN host of the POS computer (and optional ports)
// without having to rebuild the app or know URL params.
function BackendSetupModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: { host: string; httpPort: string; httpsPort: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [host, setHost] = useState(initial.host);
  const [httpPort, setHttpPort] = useState(initial.httpPort);
  const [httpsPort, setHttpsPort] = useState(initial.httpsPort);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<DiscoveredPosHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setScanHint(null);
    try {
      const list = await discoverPosHostsInBrowser();
      setHosts(list);
      if (list.length === 1) {
        setHost(list[0].host);
        setHttpPort(String(list[0].httpPort || 3333));
        setScanHint(t('server.foundOne', { name: list[0].name }));
      } else if (list.length > 1) {
        setScanHint(t('server.pickOne'));
      } else {
        setScanHint(t('server.noneFound'));
      }
    } catch (e: any) {
      setScanHint(e?.message || t('server.noneFound'));
    } finally {
      setScanning(false);
    }
  }, [t]);

  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function isValidHost(v: string): boolean {
    const trimmed = v.trim();
    if (!trimmed) return false;
    // IPv4
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
      return trimmed
        .split('.')
        .every((n) => Number(n) >= 0 && Number(n) <= 255);
    }
    // Hostname (Tailscale MagicDNS, mDNS, public domain). Conservative.
    return /^[a-zA-Z0-9]([a-zA-Z0-9-.]*[a-zA-Z0-9])?$/.test(trimmed);
  }

  function isValidPort(v: string): boolean {
    if (!v.trim()) return true; // empty is fine, defaults will apply
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 65536;
  }

  async function handleSave() {
    setError(null);
    const trimmedHost = host.trim();
    if (!isValidHost(trimmedHost)) {
      setError(t('server.invalidHost'));
      return;
    }
    if (!isValidPort(httpPort) || !isValidPort(httpsPort)) {
      setError(t('server.invalidPorts'));
      return;
    }
    setSaving(true);
    try {
      const port = Number(httpPort.trim() || '3333') || 3333;
      const isKdsApp =
        typeof window !== 'undefined' && Boolean((window as any).__KDS_APP__);
      if (isKdsApp) {
        await persistKdsBackendHost({ host: trimmedHost, httpPort: port });
        return;
      }
      syncBackendHostToLocalStorage({
        host: trimmedHost,
        httpPort: httpPort.trim() || '3333',
        httpsPort: httpsPort.trim() || '3443',
      });
      onSaved();
    } catch (e: any) {
      setError(e?.message || t('server.saveFailed'));
      setSaving(false);
    }
  }

  function handleClear() {
    try {
      localStorage.removeItem('pos_backend_host');
      localStorage.removeItem('pos_backend_http');
      localStorage.removeItem('pos_backend_https');
      onSaved();
    } catch (e: any) {
      setError(e?.message || t('server.clearFailed'));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between gap-3">
          <div className="font-semibold">{t('server.title')}</div>
          <button
            type="button"
            className="w-9 h-9 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="pos-icon"
            >
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-xs text-gray-400">
            {t('server.wifiHint', {
              macCmd: 'ipconfig getifaddr en0',
              winCmd: 'ipconfig',
            })}
          </div>
          <PosHostPicker
            hosts={hosts}
            selectedHost={host}
            selectedPort={httpPort}
            scanning={scanning}
            onSelect={(h) => {
              setHost(h.host);
              setHttpPort(String(h.httpPort || 3333));
              setScanHint(null);
            }}
            onRescan={() => void scan()}
            labels={{
              title: t('server.foundTitle'),
              scanning: t('server.scanning'),
              empty: t('server.noneFound'),
              rescan: t('server.rescan'),
            }}
          />
          {scanHint && <div className="text-xs text-gray-300">{scanHint}</div>}
          <label className="block text-sm">
            <div className="opacity-80 mb-1">{t('server.hostLabel')}</div>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 font-mono"
              placeholder={t('server.hostPlaceholder')}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              autoFocus
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <div className="opacity-80 mb-1">{t('server.httpPort')}</div>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 font-mono"
                placeholder="3333"
                value={httpPort}
                onChange={(e) =>
                  setHttpPort(e.target.value.replace(/[^0-9]/g, ''))
                }
                inputMode="numeric"
              />
            </label>
            <label className="block text-sm">
              <div className="opacity-80 mb-1">{t('server.httpsPort')}</div>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 font-mono"
                placeholder="3443"
                value={httpsPort}
                onChange={(e) =>
                  setHttpsPort(e.target.value.replace(/[^0-9]/g, ''))
                }
                inputMode="numeric"
              />
            </label>
          </div>
          {error && <div className="text-sm text-rose-300">{error}</div>}
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              className="flex-1 min-w-[120px] px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60"
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? t('common.saving') : t('server.saveReload')}
            </button>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
              type="button"
              onClick={handleClear}
              title={t('server.resetTitle')}
            >
              {t('server.reset')}
            </button>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
              type="button"
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Root() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState(() => t('boot.starting'));
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const [backendUnreachable, setBackendUnreachable] = useState(false);

  useEffect(() => {
    const onForce = (ev: any) => {
      const reason = ev?.detail?.reason
        ? String(ev.detail.reason)
        : t('boot.sessionExpired');
      const h = String(window?.location?.hash || '');
      const isAdmin = h.startsWith('#/admin');
      const isReservations = h.startsWith('#/reservations');
      // Clear only the session store(s) that belong to the panel the user
      // was actually using. Without this scoping, a 401 on the reservation
      // panel would also wipe the waiter session and dump everyone back to
      // the staff login screen.
      try {
        if (isAdmin) {
          useAdminSessionStore.getState().setUser(null as any);
        } else if (isReservations) {
          useReservationSessionStore.getState().setUser(null as any);
        } else {
          useSessionStore.getState().setUser(null);
          useAdminSessionStore.getState().setUser(null as any);
        }
      } catch {
        // ignore
      }
      // Route back to the matching login screen.
      try {
        window.location.hash = isAdmin
          ? '#/admin'
          : isReservations
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
      const staff = useSessionStore.getState() as any;
      const admin = useAdminSessionStore.getState() as any;
      const now = Date.now();
      const staffExpired =
        staff?.user &&
        typeof staff?.expiresAtMs === 'number' &&
        staff.expiresAtMs > 0 &&
        staff.expiresAtMs <= now;
      const adminExpired =
        admin?.user &&
        typeof admin?.expiresAtMs === 'number' &&
        admin.expiresAtMs > 0 &&
        admin.expiresAtMs <= now;
      if (staffExpired || adminExpired) {
        try {
          window.dispatchEvent(
            new CustomEvent('pos:forceLogout', {
              detail: { reason: t('boot.sessionExpired') },
            }),
          );
        } catch {
          // ignore
        }
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
      const onKdsSetup =
        isKdsApp &&
        String(window.location.hash || '').startsWith('#/kds-setup');
      if (onKdsSetup) {
        setReady(true);
        return;
      }

      setReady(false);
      setBackendUnreachable(false);
      setMsg(t('boot.connecting'));
      setDetail(undefined);
      const maxAttempts = isKdsApp ? 3 : 12;
      // Retry with exponential backoff. This prevents random "failed fetch" errors on slow networks.
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
          // Minimal "backend is ready" checks. KDS only needs the kitchen API;
          // waiter tablets need settings + the staff directory.
          if (isKdsApp) {
            const kdsApp = (window as any).kdsApp as
              | {
                  testConnection?: (input: {
                    host: string;
                    httpPort: number;
                  }) => Promise<{ ok: boolean; error?: string }>;
                }
              | undefined;
            const backend = resolveBackendHost();
            if (kdsApp?.testConnection) {
              const r = await kdsApp.testConnection({
                host: backend.host,
                httpPort: Number(backend.httpPort) || 3333,
              });
              if (!r.ok) throw new Error(r.error || 'KDS host unreachable');
            } else {
              await (window as any).api.kds.debug();
            }
          } else {
            await (window as any).api.settings.get();
            await (window as any).api.auth.listUsers();
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
          const baseDelay = 250;
          const delay = Math.min(5000, baseDelay * Math.pow(2, attempt));
          setMsg(t('boot.connecting'));
          setDetail(
            t('boot.retryingIn', {
              seconds: Math.round(delay / 100) / 10,
            }),
          );
          await sleep(delay);
        }
      }
      if (!cancelled) {
        const isKdsApp = Boolean((window as any).__KDS_APP__);
        if (isKdsApp) {
          try {
            window.location.hash = '#/kds-setup';
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
  }, [nonce, t]);

  if (!ready) {
    return (
      <BootScreen
        message={msg}
        detail={detail}
        canRetry={backendUnreachable}
        onRetry={() => setNonce((n) => n + 1)}
      />
    );
  }
  return (
    <>
      <RouterProvider router={router} />
      {(window as any).__KDS_APP__ ? <UpdateNotification /> : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <LocaleSync>
        <ErrorBoundary>
          <LicenseGate>
            <Root />
          </LicenseGate>
          <Toaster />
        </ErrorBoundary>
      </LocaleSync>
    </I18nextProvider>
  </React.StrictMode>,
);
