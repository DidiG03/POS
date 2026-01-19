const API_URL = (import.meta.env?.VITE_API_URL as string) || '';

let token: string | null = null;
try {
  token = localStorage.getItem('authToken');
} catch {
  token = null;
}

export const apiState = { loading: false };
let pending = 0;
function setLoading(v: boolean) {
  apiState.loading = v;
}
function start() {
  pending += 1;
  setLoading(true);
}
function end() {
  pending = Math.max(0, pending - 1);
  if (pending === 0) setLoading(false);
}

async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  start();
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const message = (data && (data.message || data.error)) || res.statusText;
      throw new Error(message);
    }
    return data as T;
  } finally {
    end();
  }
}

function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem('authToken', t);
    else localStorage.removeItem('authToken');
  } catch {
    /* ignore */
  }
}

export const api = {
  auth: {
    async loginWithPin(pin: string, userId?: number) {
      const data = await request<{ token?: string; user: any }>('POST', '/auth/login-pin', { pin, userId });
      if (data?.token) setToken(data.token);
      return data.user;
    },
    async syncStaffFromApi() {
      await request('POST', '/auth/sync-staff');
    },
    async listUsers() {
      return await request<any[]>('GET', '/auth/users');
    },
    async login(credentials?: any) {
      const data = await request<{ token?: string; user: any }>('POST', '/auth/login', credentials);
      if (data?.token) setToken(data.token);
      return data.user;
    },
    async logout() {
      await request('POST', '/auth/logout');
      setToken(null);
    },
  },
  shifts: {
    async getOpen(userId: number) {
      return await request<any | null>('GET', `/shifts/open?userId=${userId}`);
    },
    async listOpen() {
      return await request<number[]>('GET', '/shifts/open');
    },
    async clockIn(userId: number) {
      await request('POST', '/shifts/clock-in', { userId });
    },
    async clockOut(userId: number) {
      await request('POST', '/shifts/clock-out', { userId });
    },
  },
  notifications: {
    async list(userId: number, onlyUnread?: boolean) {
      const query = new URLSearchParams({ userId: String(userId) });
      if (onlyUnread) query.set('onlyUnread', '1');
      return await request<any[]>('GET', `/notifications?${query.toString()}`);
    },
    async markAllRead(userId: number) {
      await request('POST', '/notifications/mark-all-read', { userId });
    },
  },
  admin: {
    async listNotifications(opts: any) {
      const query = new URLSearchParams();
      if (opts?.onlyUnread) query.set('onlyUnread', '1');
      if (opts?.limit) query.set('limit', String(opts.limit));
      if (opts?.offset) query.set('offset', String(opts.offset));
      return await request<any[]>('GET', `/admin/notifications?${query.toString()}`);
    },
    async markAllNotificationsRead() {
      await request('POST', '/admin/notifications/mark-all-read');
    },
    async getOverview() {
      return await request<any>('GET', '/admin/overview');
    },
    async listShifts() {
      return await request<any[]>('GET', '/admin/shifts');
    },
    async getTopSellingToday() {
      return await request<any>('GET', '/admin/top-selling-today');
    },
    async getSalesTrends(opts: any) {
      return await request<any>('POST', '/admin/sales-trends', opts);
    },
    async listTicketsByUser(userId: number, range: any) {
      return await request<any[]>('POST', `/admin/tickets/by-user/${userId}`, range);
    },
    async listTicketCounts(range: any) {
      return await request<any[]>('POST', '/admin/tickets/counts', range);
    },
    async openWindow() {
      await request('POST', '/admin/open-window');
    },
  },
  menu: {
    async listCategoriesWithItems() {
      return await request<any[]>('GET', '/menu');
    },
  },
  tickets: {
    async voidTicket(opts: any) {
      await request('POST', '/tickets/void', opts);
    },
    async log(opts: any) {
      await request('POST', '/tickets', opts);
    },
    async getLatestForTable(area: string, label: string) {
      const query = new URLSearchParams({ area, label });
      return await request<any | null>('GET', `/tickets/latest?${query.toString()}`);
    },
    async voidItem(opts: any) {
      await request('POST', '/tickets/item/void', opts);
    },
  },
  covers: {
    async getLast(area: string, label: string) {
      const query = new URLSearchParams({ area, label });
      return await request<number>('GET', `/covers?${query.toString()}`);
    },
    async save(area: string, label: string, num: number) {
      await request('POST', '/covers', { area, label, num });
    },
  },
  settings: {
    async get() {
      return await request<any>('GET', '/settings');
    },
    async update(opts: any) {
      await request('PUT', '/settings', opts);
    },
    async testPrint() {
      try {
        await request('POST', '/settings/test-print');
        return true;
      } catch {
        return false;
      }
    },
  },
  tables: {
    async setOpen(area: string, label: string, open: boolean) {
      await request('POST', '/tables/open', { area, label, open });
    },
  },
  layout: {
    async get(userId: number, area: string) {
      const query = new URLSearchParams({ userId: String(userId), area });
      return await request<any | null>('GET', `/layout?${query.toString()}`);
    },
    async save(userId: number, area: string, nodes: any) {
      await request('POST', '/layout', { userId, area, nodes });
    },
  },
};
