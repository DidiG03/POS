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
  async function go(path: string, opts?: RequestInit) {
    try {
      const r = await fetch(HTTPS_BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      if (!r.ok) throw new Error(String(r.status));
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : r.text();
    } catch {
      const r2 = await fetch(HTTP_BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
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
      async update() { throw new Error('not supported in browser'); },
      async testPrint() { return false; },
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
      async get() { throw new Error('not supported in browser'); },
      async save() { throw new Error('not supported in browser'); },
    },
    notifications: {
      async list() { throw new Error('not supported in browser'); },
      async markAllRead() { throw new Error('not supported in browser'); },
    },
  };
}
const router = createHashRouter(routes);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

offlineQueue.sync().catch(() => {});


