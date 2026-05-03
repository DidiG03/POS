import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import { routes } from './routes';
import './styles/index.css';
import { offlineQueue } from './utils/offlineQueue';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/Toaster';
import { initMobileShell } from './utils/mobileShell';
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
  const CLOUD_BASE_RAW = String(
    (import.meta as any)?.env?.VITE_POS_CLOUD_URL || '',
  ).trim();
  let CLOUD_BASE = CLOUD_BASE_RAW ? CLOUD_BASE_RAW.replace(/\/+$/g, '') : '';
  let IS_CLOUD = Boolean(CLOUD_BASE);
  const BUSINESS_KEY = 'pos_business_code';
  const TOKEN_KEY_CLOUD = 'pos_cloud_token';
  const TOKEN_KEY_LOCAL = 'pos_api_token';
  const getToken = () => {
    try {
      return localStorage.getItem(IS_CLOUD ? TOKEN_KEY_CLOUD : TOKEN_KEY_LOCAL);
    } catch (e) {
      void e;
      return null;
    }
  };
  const setToken = (t: string | null) => {
    try {
      const key = IS_CLOUD ? TOKEN_KEY_CLOUD : TOKEN_KEY_LOCAL;
      if (t) localStorage.setItem(key, t);
      else localStorage.removeItem(key);
    } catch (e) {
      void e;
    }
  };

  const getBusinessCode = () => {
    try {
      return (localStorage.getItem(BUSINESS_KEY) || '').trim().toUpperCase();
    } catch {
      return '';
    }
  };

  const setBusinessCode = (code: string) => {
    try {
      const v = String(code || '')
        .trim()
        .toUpperCase();
      if (v) localStorage.setItem(BUSINESS_KEY, v);
      else localStorage.removeItem(BUSINESS_KEY);
    } catch {
      // ignore
    }
  };

  const pickBackend = () => {
    const params = new URLSearchParams(window.location.search);
    const backParam = params.get('backend'); // e.g., 192.168.1.50
    const httpParam = params.get('http'); // e.g., 3333
    const httpsParam = params.get('https'); // e.g., 3443
    if (backParam) localStorage.setItem('pos_backend_host', backParam);
    if (httpParam) localStorage.setItem('pos_backend_http', httpParam);
    if (httpsParam) localStorage.setItem('pos_backend_https', httpsParam);
    // Inside Capacitor (iOS/Android WebView) window.location.hostname is
    // "localhost" / capacitor-scheme, so we cannot use it as a fallback.
    // Use VITE_DEFAULT_BACKEND_HOST baked at build time instead.
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
    const host =
      localStorage.getItem('pos_backend_host') ||
      envHost ||
      (isMobileShell ? '' : window.location.hostname) ||
      'localhost';
    const httpPort =
      localStorage.getItem('pos_backend_http') || envHttp || '3333';
    const httpsPort =
      localStorage.getItem('pos_backend_https') || envHttps || '3443';
    return { host, httpPort, httpsPort };
  };
  const { host, httpPort, httpsPort } = pickBackend();
  const HTTPS_BASE = `https://${host}:${httpsPort}`;
  const HTTP_BASE = `http://${host}:${httpPort}`;
  const CLIENT_TIMEOUT_MS = 5000;

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

  // Simple SSE client for real-time updates
  let es: EventSource | null = null;
  const stopSse = () => {
    try {
      if (es) es.close();
    } catch {
      // ignore
    }
    es = null;
  };
  const startSse = () => {
    try {
      if (IS_CLOUD) return; // cloud mode uses polling for now
      const token = getToken();
      if (!token) return;
      if (es) stopSse();
      const url = `${HTTP_BASE}/events?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);
      es.addEventListener('tables', (ev: any) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          const { area, label, open } = data || {};
          if (area && label && typeof open === 'boolean') {
            const store = (window as any).__tableStatusStore__;
            if (store && store.setOpen) store.setOpen(area, label, open);
          }
        } catch (e) {
          void e;
        }
      });
    } catch (e) {
      void e;
    }
  };
  startSse();

  // Ensure "manual logout" clears the browser token + closes SSE.
  try {
    window.addEventListener('pos:forceLogout', () => {
      try {
        localStorage.removeItem(TOKEN_KEY_LOCAL);
        localStorage.removeItem(TOKEN_KEY_CLOUD);
      } catch {
        // ignore
      }
      stopSse();
    });
    window.addEventListener('beforeunload', stopSse);
    window.addEventListener('pagehide', stopSse);
  } catch {
    // ignore
  }

  function isRetryableNetworkError(e: any) {
    const name = String(e?.name || '');
    // fetch() network failures are commonly TypeError; timeouts become AbortError
    return name === 'AbortError' || e instanceof TypeError;
  }

  async function fetchWithRetry(url: string, init: RequestInit, attempts = 2) {
    let lastErr: any = null;
    for (let i = 0; i <= attempts; i++) {
      try {
        return await fetchWithTimeout(url, init);
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
    constructor(status: number) {
      super(String(status));
      this.status = status;
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

  async function go(path: string, opts?: RequestInit) {
    const token = getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(((opts?.headers as any) || {}) as any),
    };
    if (IS_CLOUD) {
      const r = await fetchWithRetry(CLOUD_BASE + path, { ...opts, headers });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403)
          forceLogout('Session expired');
        throw new HttpError(r.status);
      }
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    } else {
      // Prefer HTTP first to avoid self-signed cert warnings in browsers, then fallback to HTTPS
      try {
        const r = await fetchWithRetry(HTTP_BASE + path, { ...opts, headers });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403)
            forceLogout('Session expired');
          throw new HttpError(r.status);
        }
        const ct = r.headers.get('content-type') || '';
        return ct.includes('application/json') ? r.json() : r.text();
      } catch (e: any) {
        // Only fall back to HTTPS when HTTP failed due to network/timeouts.
        if (!isRetryableNetworkError(e)) throw e;
        const r2 = await fetchWithRetry(HTTPS_BASE + path, {
          ...opts,
          headers,
        });
        if (!r2.ok) {
          if (r2.status === 401 || r2.status === 403)
            forceLogout('Session expired');
          throw new HttpError(r2.status);
        }
        const ct2 = r2.headers.get('content-type') || '';
        return ct2.includes('application/json') ? r2.json() : r2.text();
      }
    }
  }

  // Always call the host LAN API (even when cloud mode is enabled).
  async function goLan(path: string, opts?: RequestInit) {
    const token = getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(((opts?.headers as any) || {}) as any),
    };
    // Prefer HTTP first to avoid self-signed cert warnings in browsers, then fallback to HTTPS
    try {
      const r = await fetchWithRetry(HTTP_BASE + path, { ...opts, headers });
      if (!r.ok) {
        // Only treat 401/403 as "session expired" if we actually have a token.
        if (token && (r.status === 401 || r.status === 403))
          forceLogout('Session expired');
        throw new HttpError(r.status);
      }
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    } catch (e: any) {
      if (!isRetryableNetworkError(e)) throw e;
      const r2 = await fetchWithRetry(HTTPS_BASE + path, { ...opts, headers });
      if (!r2.ok) {
        if (token && (r2.status === 401 || r2.status === 403))
          forceLogout('Session expired');
        throw new HttpError(r2.status);
      }
      const ct2 = r2.headers.get('content-type') || '';
      return ct2.includes('application/json') ? r2.json() : r2.text();
    }
  }

  // Auto-detect cloud config from the host LAN settings so tablets "just work".
  (async () => {
    try {
      const wasCloud = IS_CLOUD;
      const s: any = await goLan('/settings').catch(() => null);
      const backendUrl = String((s as any)?.cloud?.backendUrl || '')
        .trim()
        .replace(/\/+$/g, '');
      const businessCode = String((s as any)?.cloud?.businessCode || '')
        .trim()
        .toUpperCase();
      if (backendUrl && businessCode) {
        CLOUD_BASE = backendUrl;
        IS_CLOUD = true;
        setBusinessCode(businessCode);
      }
      (window as any).__CLOUD_CLIENT__ = Boolean(IS_CLOUD);

      // If we just switched into cloud mode, clear any stale local persisted sessions (local DB users)
      // and notify the UI to reload login/user lists.
      if (!wasCloud && IS_CLOUD) {
        try {
          localStorage.removeItem('pos-session');
          localStorage.removeItem('pos-admin-session');
          localStorage.removeItem('pos_api_token');
        } catch {
          // ignore
        }
        try {
          window.dispatchEvent(new Event('pos:cloudConfigChanged'));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  })();

  (window as any).api = {
    auth: {
      async loginWithPin(pin: string, userId?: number, pairingCode?: string) {
        // Tablets are served from the host LAN API. Enforce host pairing code before any login (even in cloud mode).
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
      async listUsers(_input?: { includeAdmins?: boolean }) {
        // Always go through the LAN host for user listing so tablets never need the provider-supplied business password.
        // Host will proxy cloud /auth/public-users if cloud is enabled.
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
        if (IS_CLOUD) {
          const bc = getBusinessCode();
          return {
            enableAdmin: true,
            cloud: { backendUrl: CLOUD_BASE, businessCode: bc || undefined },
            // For now, keep UI preferences local on each device.
            tableAreas: [
              { name: 'Main Hall', count: 8 },
              { name: 'Terrace', count: 4 },
            ],
          };
        }
        return await goLan('/settings');
      },
      async update(input: any) {
        if (IS_CLOUD) {
          const bc = String(input?.cloud?.businessCode || '').trim();
          setBusinessCode(bc);
          return await (window as any).api.settings.get();
        }
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
          const err = r && (r.error || r.message) ? String(r.error || r.message) : '';
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
        await goLan('/tickets', { method: 'POST', body: JSON.stringify(input) });
        return true;
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
        if (IS_CLOUD) {
          const { recordOnly, ...payload } = (input || {}) as any;
          await goLan('/print-jobs/enqueue', {
            method: 'POST',
            body: JSON.stringify({
              type: 'RECEIPT',
              payload,
              recordOnly: Boolean(recordOnly),
            }),
          });
          return true;
        }
        const r = await goLan('/print/ticket', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        const ok = !!(r && r.ok === true);
        if (!ok) {
          const err = r && (r.error || r.message) ? String(r.error || r.message) : '';
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
        return await goLan(`/kds/tickets?${q.toString()}`);
      },
      async bump(input: any) {
        const station = String(input?.station || 'KITCHEN').toUpperCase();
        const ticketId = Number(input?.ticketId || 0);
        const r = await goLan('/kds/bump', {
          method: 'POST',
          body: JSON.stringify({ station, ticketId }),
        });
        return Boolean((r as any)?.ok ?? true);
      },
      async bumpItem(input: any) {
        const station = String(input?.station || 'KITCHEN').toUpperCase();
        const ticketId = Number(input?.ticketId || 0);
        const itemIdx = Number(input?.itemIdx ?? input?.idx ?? -1);
        const r = await goLan('/kds/bump-item', {
          method: 'POST',
          body: JSON.stringify({ station, ticketId, itemIdx }),
        });
        return Boolean((r as any)?.ok ?? true);
      },
      async debug() {
        return await goLan('/kds/debug');
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
      async get(userId: number, area: string) {
        return await goLan(
          `/layout/get?userId=${encodeURIComponent(String(userId))}&area=${encodeURIComponent(area)}`,
        );
      },
      async save(userId: number, area: string, nodes: any[]) {
        await goLan('/layout/save', {
          method: 'POST',
          body: JSON.stringify({ userId, area, nodes }),
        });
        return true;
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
  (window as any).__CLOUD_CLIENT__ = Boolean(IS_CLOUD);
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
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const [showSetup, setShowSetup] = useState(false);
  const [setupNonce, setSetupNonce] = useState(0);
  const backend = useMemo(() => {
    try {
      const host =
        localStorage.getItem('pos_backend_host') ||
        window.location.hostname ||
        'localhost';
      const httpPort = localStorage.getItem('pos_backend_http') || '3333';
      const httpsPort = localStorage.getItem('pos_backend_https') || '3443';
      return { host, httpPort, httpsPort };
    } catch {
      return {
        host: window.location.hostname || 'localhost',
        httpPort: '3333',
        httpsPort: '3443',
      };
    }
    // setupNonce forces a re-read after the user saves new settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupNonce]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-gray-100 px-6">
      <div className="flex flex-col items-center gap-4 w-full max-w-md">
        <svg
          className="w-7 h-7 animate-spin text-indigo-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <div className="text-sm text-gray-300 text-center">{message}</div>
        {detail && (
          <div className="text-xs text-gray-500 text-center">{detail}</div>
        )}
        {isBrowser && (
          <div className="text-xs text-gray-500 text-center">
            Backend:{' '}
            <span className="font-mono">
              {backend.host}:{backend.httpPort}
            </span>
          </div>
        )}
        {(canRetry || isBrowser) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 justify-center">
            {canRetry && onRetry && (
              <button
                className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                onClick={onRetry}
              >
                Retry
              </button>
            )}
            {isBrowser && (
              <button
                className="px-4 py-2 rounded bg-indigo-700 hover:bg-indigo-600 text-sm"
                onClick={() => setShowSetup(true)}
                type="button"
              >
                Configure server
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
  const [host, setHost] = useState(initial.host);
  const [httpPort, setHttpPort] = useState(initial.httpPort);
  const [httpsPort, setHttpsPort] = useState(initial.httpsPort);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError('Enter a valid IP address or hostname');
      return;
    }
    if (!isValidPort(httpPort) || !isValidPort(httpsPort)) {
      setError('Ports must be numbers between 1 and 65535');
      return;
    }
    setSaving(true);
    try {
      localStorage.setItem('pos_backend_host', trimmedHost);
      if (httpPort.trim())
        localStorage.setItem('pos_backend_http', httpPort.trim());
      else localStorage.removeItem('pos_backend_http');
      if (httpsPort.trim())
        localStorage.setItem('pos_backend_https', httpsPort.trim());
      else localStorage.removeItem('pos_backend_https');
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Failed to save settings');
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
      setError(e?.message || 'Failed to clear settings');
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
          <div className="font-semibold">POS server</div>
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
              className="w-4 h-4"
            >
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-xs text-gray-400">
            Make sure your phone is on the same Wi-Fi as the POS computer.
            On the POS computer, run <span className="font-mono">ipconfig getifaddr en0</span>{' '}
            (Mac) or <span className="font-mono">ipconfig</span> (Windows) to find its IP.
          </div>
          <label className="block text-sm">
            <div className="opacity-80 mb-1">Host (IP or name)</div>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 font-mono"
              placeholder="e.g. 192.168.1.42 or pos-hall.local"
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
              <div className="opacity-80 mb-1">HTTP port</div>
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
              <div className="opacity-80 mb-1">HTTPS port</div>
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
              {saving ? 'Saving…' : 'Save & reload'}
            </button>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
              type="button"
              onClick={handleClear}
              title="Forget saved server and use auto-detection"
            >
              Reset
            </button>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Root() {
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState('Starting POS…');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const onForce = (ev: any) => {
      const reason = ev?.detail?.reason
        ? String(ev.detail.reason)
        : 'Session expired';
      // Clear both staff + admin sessions (safe default)
      try {
        useSessionStore.getState().setUser(null);
        useAdminSessionStore.getState().setUser(null as any);
      } catch {
        // ignore
      }
      // Navigate to the appropriate login screen based on current context.
      // This prevents "Admin logout" from dumping the user into the staff login.
      try {
        const h = String(window.location.hash || '');
        const isAdmin = h.startsWith('#/admin');
        window.location.hash = isAdmin ? '#/admin' : '#/';
      } catch {
        // ignore
      }
      // Optional: show a short hint on boot screen (if it appears)
      setMsg('Please login again');
      setDetail(reason);
    };
    window.addEventListener('pos:forceLogout', onForce as any);
    return () => window.removeEventListener('pos:forceLogout', onForce as any);
  }, []);

  useEffect(() => {
    // Session expiry for Electron (persisted zustand sessions).
    // Browser clients already rely on API token expiry; they will trigger pos:forceLogout on 401/403.
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
              detail: { reason: 'Session expired' },
            }),
          );
        } catch {
          // ignore
        }
      }
    };
    tick();
    const t = window.setInterval(tick, 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setReady(false);
      setMsg('Connecting to POS backend…');
      setDetail(undefined);
      // Retry with exponential backoff. This prevents random "failed fetch" errors on slow networks.
      for (let attempt = 0; attempt < 12 && !cancelled; attempt++) {
        try {
          if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            setMsg('You are offline');
            setDetail('Connect to Wi‑Fi/LAN and we will retry automatically.');
            await sleep(750);
            continue;
          }
          // Minimal "backend is ready" checks:
          // 1) settings (proves API is responsive)
          // 2) users list (proves DB is responsive)
          await (window as any).api.settings.get();
          await (window as any).api.auth.listUsers();
          if (cancelled) return;
          setReady(true);
          setMsg('Starting POS…');
          setDetail(undefined);
          // After backend is confirmed, run offline sync (safe for Electron + browser)
          offlineQueue.sync().catch(() => {});
          return;
        } catch (e: any) {
          void e;
          const baseDelay = 250;
          const delay = Math.min(5000, baseDelay * Math.pow(2, attempt));
          setMsg('Connecting to POS backend…');
          setDetail(`Retrying in ${Math.round(delay / 100) / 10}s`);
          await sleep(delay);
        }
      }
      if (!cancelled) {
        setMsg('Cannot reach POS backend');
        setDetail(
          'Check that the host PC is running and you are on the same Wi‑Fi.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  if (!ready) {
    return (
      <BootScreen
        message={msg}
        detail={detail}
        canRetry={msg === 'Cannot reach POS backend'}
        onRetry={() => setNonce((n) => n + 1)}
      />
    );
  }
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
      <Toaster />
    </ErrorBoundary>
  </React.StrictMode>,
);
