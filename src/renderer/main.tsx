import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import { routes } from './routes';
import './styles/index.css';
import { offlineQueue } from './utils/offlineQueue';
// PWA registration disabled for desktop build

// Polyfill window.api for browser (tablets) by calling the LAN HTTP API
// When running inside Electron, preload already defines window.api
if (!(window as any).api) {
  const pickBackend = () => {
    const params = new URLSearchParams(window.location.search);
    const backParam = params.get('backend'); // e.g., 192.168.1.50
    const httpParam = params.get('http'); // e.g., 3333
    const httpsParam = params.get('https'); // e.g., 3443
    if (backParam) localStorage.setItem('pos_backend_host', backParam);
    if (httpParam) localStorage.setItem('pos_backend_http', httpParam);
    if (httpsParam) localStorage.setItem('pos_backend_https', httpsParam);
    const host = localStorage.getItem('pos_backend_host') || window.location.hostname || 'localhost';
    const httpPort = localStorage.getItem('pos_backend_http') || '3333';
    const httpsPort = localStorage.getItem('pos_backend_https') || '3443';
    return { host, httpPort, httpsPort };
  };
  const { host, httpPort, httpsPort } = pickBackend();
  const HTTPS_BASE = `https://${host}:${httpsPort}`;
  const HTTP_BASE = `http://${host}:${httpPort}`;
  // Simple SSE client for real-time updates
  try {
    const es = new EventSource(HTTP_BASE + '/events');
    es.addEventListener('tables', (ev: any) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        const { area, label, open } = data || {};
        if (area && label && typeof open === 'boolean') {
          const store = (window as any).__tableStatusStore__;
          if (store && store.setOpen) store.setOpen(area, label, open);
        }
      } catch {}
    });
  } catch {}
  async function go(path: string, opts?: RequestInit) {
    // Prefer HTTP first to avoid self-signed cert warnings in browsers, then fallback to HTTPS
    try {
      const r = await fetch(HTTP_BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      if (!r.ok) throw new Error(String(r.status));
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    } catch {
      const r2 = await fetch(HTTPS_BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      if (!r2.ok) throw new Error(String(r2.status));
      const ct2 = r2.headers.get('content-type') || '';
      return ct2.includes('application/json') ? r2.json() : r2.text();
    }
  }
  (window as any).api = {
    auth: {
      async loginWithPin(pin: string, userId?: number) {
        return await go('/auth/login', { method: 'POST', body: JSON.stringify({ pin, userId }) });
      },
      async createUser() { throw new Error('not supported in browser'); },
      async listUsers() { return await go('/auth/users'); },
      async updateUser() { throw new Error('not supported in browser'); },
      async syncStaffFromApi() { throw new Error('not supported in browser'); },
    },
    menu: {
      async syncFromUrl() { throw new Error('not supported in browser'); },
      async listCategoriesWithItems() { return await go('/menu/categories'); },
    },
    settings: {
      async get() { return await go('/settings'); },
      async update(input: any) { return await go('/settings/update', { method: 'POST', body: JSON.stringify(input) }); },
      async testPrint() { const r = await go('/print/test', { method: 'POST', body: JSON.stringify({}) }); return !!(r && (r.ok === true)); },
      async setPrinter() { throw new Error('not supported in browser'); },
    },
    shifts: {
      async getOpen(userId: number) { return await go(`/shifts/get-open?userId=${encodeURIComponent(String(userId))}`); },
      async clockIn(userId: number) { return await go('/shifts/clock-in', { method: 'POST', body: JSON.stringify({ userId }) }); },
      async clockOut(userId: number) { return await go('/shifts/clock-out', { method: 'POST', body: JSON.stringify({ userId }) }); },
      async listOpen() { return await go('/shifts/open'); },
    },
    tickets: {
      async log(input: any) { await go('/tickets', { method: 'POST', body: JSON.stringify(input) }); return true; },
      async getLatestForTable(area: string, tableLabel: string) { return await go(`/tickets/latest?area=${encodeURIComponent(area)}&table=${encodeURIComponent(tableLabel)}`); },
      async voidItem(input: any) { await go('/tickets/void-item', { method: 'POST', body: JSON.stringify(input) }); return true; },
      async voidTicket(input: any) { await go('/tickets/void-ticket', { method: 'POST', body: JSON.stringify(input) }); return true; },
      async print(input: any) { const r = await go('/print/ticket', { method: 'POST', body: JSON.stringify(input) }); return !!(r && (r.ok === true)); },
    },
    tables: {
      async setOpen(area: string, label: string, open: boolean) { await go('/tables/open', { method: 'POST', body: JSON.stringify({ area, label, open }) }); return true; },
      async listOpen() { return await go('/tables/open'); },
    },
    covers: {
      async save(area: string, label: string, covers: number) { await go('/covers/save', { method: 'POST', body: JSON.stringify({ area, label, covers }) }); return true; },
      async getLast(area: string, label: string) { return await go(`/covers/last?area=${encodeURIComponent(area)}&label=${encodeURIComponent(label)}`); },
    },
    admin: {
      async getOverview() { return await go('/admin/overview'); },
      async openWindow() { return false; },
      async listShifts() { throw new Error('not supported in browser'); },
      async listTicketCounts() { throw new Error('not supported in browser'); },
      async listTicketsByUser() { throw new Error('not supported in browser'); },
      async listNotifications() { throw new Error('not supported in browser'); },
      async markAllNotificationsRead() { return false; },
      async getTopSellingToday() { throw new Error('not supported in browser'); },
      async getSalesTrends(input: any) { const range = input?.range || 'daily'; return await go(`/admin/sales-trends?range=${encodeURIComponent(range)}`); },
    },
    layout: {
      async get(userId: number, area: string) { return await go(`/layout/get?userId=${encodeURIComponent(String(userId))}&area=${encodeURIComponent(area)}`); },
      async save(userId: number, area: string, nodes: any[]) { await go('/layout/save', { method: 'POST', body: JSON.stringify({ userId, area, nodes }) }); return true; },
    },
    notifications: {
      async list() { throw new Error('not supported in browser'); },
      async markAllRead() { throw new Error('not supported in browser'); },
    },
    requests: {
      create: async (input: any) => go('/requests/create', { method: 'POST', body: JSON.stringify(input) }).then(() => true),
      listForOwner: async (ownerId: number) => go(`/requests/list-for-owner?ownerId=${encodeURIComponent(String(ownerId))}`),
      approve: async (id: number, ownerId: number) => go('/requests/approve', { method: 'POST', body: JSON.stringify({ id, ownerId }) }).then(() => true),
      reject: async (id: number, ownerId: number) => go('/requests/reject', { method: 'POST', body: JSON.stringify({ id, ownerId }) }).then(() => true),
      pollApprovedForTable: async (ownerId: number, area: string, tableLabel: string) => go(`/requests/poll-approved?ownerId=${encodeURIComponent(String(ownerId))}&area=${encodeURIComponent(area)}&tableLabel=${encodeURIComponent(tableLabel)}`),
      markApplied: async (ids: number[]) => go('/requests/mark-applied', { method: 'POST', body: JSON.stringify({ ids }) }).then(() => true),
    },
  };
  (window as any).__BROWSER_CLIENT__ = true;
}
const router = createHashRouter(routes);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

offlineQueue.sync().catch(() => {});


