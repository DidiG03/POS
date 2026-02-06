// Preload must be CommonJS-compatible. Avoid top-level ESM-only features.
import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '@shared/ipc';

const api: Api = {
  auth: {
    loginWithPin: (pin: string, userId?: number, pairingCode?: string) =>
      ipcRenderer.invoke('auth:loginWithPin', { pin, userId, pairingCode }),
    verifyManagerPin: (pin: string) =>
      ipcRenderer.invoke('auth:verifyManagerPin', { pin }),
    logoutAdmin: () => ipcRenderer.invoke('auth:logoutAdmin'),
    createUser: (input) => ipcRenderer.invoke('auth:createUser', input),
    listUsers: (input?: { includeAdmins?: boolean }) =>
      ipcRenderer.invoke('auth:listUsers', input || {}),
    updateUser: (input) => ipcRenderer.invoke('auth:updateUser', input),
    syncStaffFromApi: (url?: string) =>
      ipcRenderer.invoke('auth:syncStaffFromApi', { url }),
    deleteUser: (input) => ipcRenderer.invoke('auth:deleteUser', input),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (input) => ipcRenderer.invoke('settings:update', input),
    testPrint: () => ipcRenderer.invoke('settings:testPrint'),
    setPrinter: (input) => ipcRenderer.invoke('settings:setPrinter', input),
    testPrintVerbose: () => ipcRenderer.invoke('settings:testPrintVerbose'),
    listPrinters: () => ipcRenderer.invoke('printer:list'),
    listSerialPorts: () => ipcRenderer.invoke('printer:listSerialPorts'),
  },
  menu: {
    listCategoriesWithItems: () =>
      ipcRenderer.invoke('menu:listCategoriesWithItems'),
    createCategory: (input) => ipcRenderer.invoke('menu:createCategory', input),
    updateCategory: (input) => ipcRenderer.invoke('menu:updateCategory', input),
    deleteCategory: (id: number) =>
      ipcRenderer.invoke('menu:deleteCategory', { id }),
    createItem: (input) => ipcRenderer.invoke('menu:createItem', input),
    updateItem: (input) => ipcRenderer.invoke('menu:updateItem', input),
    deleteItem: (id: number) => ipcRenderer.invoke('menu:deleteItem', { id }),
  },
  shifts: {
    getOpen: (userId: number) =>
      ipcRenderer.invoke('shifts:getOpen', { userId }),
    clockIn: (userId: number) =>
      ipcRenderer.invoke('shifts:clockIn', { userId }),
    clockOut: (userId: number) =>
      ipcRenderer.invoke('shifts:clockOut', { userId }),
    listOpen: () => ipcRenderer.invoke('shifts:listOpen'),
  },
  admin: {
    getOverview: () => ipcRenderer.invoke('admin:getOverview'),
    openWindow: () => ipcRenderer.invoke('admin:openWindow'),
    listShifts: (input?: { startIso?: string; endIso?: string }) =>
      ipcRenderer.invoke('admin:listShifts', input || {}),
    listTicketCounts: (input?: { startIso?: string; endIso?: string }) =>
      ipcRenderer.invoke('admin:listTicketCounts', input),
    listTicketsByUser: (
      userId: number,
      range?: { startIso?: string; endIso?: string },
    ) =>
      ipcRenderer.invoke('admin:listTicketsByUser', {
        userId,
        ...(range || {}),
      }),
    listNotifications: (input?: { onlyUnread?: boolean; limit?: number }) =>
      ipcRenderer.invoke('admin:listNotifications', input || {}),
    markAllNotificationsRead: () =>
      ipcRenderer.invoke('admin:markAllNotificationsRead'),
    getTopSellingToday: () => ipcRenderer.invoke('admin:getTopSellingToday'),
    getSalesTrends: (input: { range: 'daily' | 'weekly' | 'monthly' }) =>
      ipcRenderer.invoke('admin:getSalesTrends', input),
    getSecurityLog: (limit?: number) =>
      ipcRenderer.invoke('admin:getSecurityLog', { limit }),
    getMemoryStats: () => ipcRenderer.invoke('admin:getMemoryStats'),
    exportMemorySnapshot: () =>
      ipcRenderer.invoke('admin:exportMemorySnapshot'),
  },
  kds: {
    openWindow: () => ipcRenderer.invoke('kds:openWindow'),
    listTickets: (input: {
      station: 'KITCHEN' | 'BAR' | 'DESSERT';
      status: 'NEW' | 'DONE';
      limit?: number;
    }) => ipcRenderer.invoke('kds:listTickets', input),
    bump: (input: {
      station: 'KITCHEN' | 'BAR' | 'DESSERT';
      ticketId: number;
      userId?: number;
    }) => ipcRenderer.invoke('kds:bump', input),
    bumpItem: (input: {
      station: 'KITCHEN' | 'BAR' | 'DESSERT';
      ticketId: number;
      itemIdx: number;
      userId?: number;
    }) => ipcRenderer.invoke('kds:bumpItem', input),
    debug: () => ipcRenderer.invoke('kds:debug'),
  },
  backups: {
    list: () => ipcRenderer.invoke('backups:list'),
    create: () => ipcRenderer.invoke('backups:create'),
    restore: (input: { name: string }) =>
      ipcRenderer.invoke('backups:restore', input),
  },
  reports: {
    getMyOverview: (userId: number) =>
      ipcRenderer.invoke('reports:getMyOverview', { userId }),
    getMyTopSellingToday: (userId: number) =>
      ipcRenderer.invoke('reports:getMyTopSellingToday', { userId }),
    getMySalesTrends: (input: {
      userId: number;
      range: 'daily' | 'weekly' | 'monthly';
    }) => ipcRenderer.invoke('reports:getMySalesTrends', input),
    listMyActiveTickets: (userId: number) =>
      ipcRenderer.invoke('reports:listMyActiveTickets', { userId }),
    listMyPaidTickets: (input: {
      userId: number;
      q?: string;
      limit?: number;
    }) => ipcRenderer.invoke('reports:listMyPaidTickets', input),
  },
  offline: {
    getStatus: () => ipcRenderer.invoke('offline:getStatus'),
  },
  billing: {
    getStatus: () => ipcRenderer.invoke('billing:getStatus'),
    getStatusLive: () => ipcRenderer.invoke('billing:getStatusLive'),
    createCheckoutSession: () =>
      ipcRenderer.invoke('billing:createCheckoutSession'),
    createPortalSession: () =>
      ipcRenderer.invoke('billing:createPortalSession'),
  },
  system: {
    openExternal: (url: string) =>
      ipcRenderer.invoke('system:openExternal', { url }),
  },
  layout: {
    get: (userId: number, area: string) =>
      ipcRenderer.invoke('layout:get', { userId, area }),
    save: (userId: number, area: string, nodes: any[]) =>
      ipcRenderer.invoke('layout:save', { userId, area, nodes }),
  },
  covers: {
    save: (area: string, label: string, covers: number) =>
      ipcRenderer.invoke('covers:save', { area, label, covers }),
    getLast: (area: string, label: string) =>
      ipcRenderer.invoke('covers:getLast', { area, label }),
  },
  tickets: {
    log: (payload: any) => ipcRenderer.invoke('tickets:log', payload),
    getLatestForTable: (area: string, tableLabel: string) =>
      ipcRenderer.invoke('tickets:getLatestForTable', { area, tableLabel }),
    voidItem: (payload: any) => ipcRenderer.invoke('tickets:voidItem', payload),
    voidTicket: (payload: any) =>
      ipcRenderer.invoke('tickets:voidTicket', payload),
    getTableTooltip: (area: string, tableLabel: string) =>
      ipcRenderer.invoke('tickets:getTableTooltip', { area, tableLabel }),
    print: (payload: any) => ipcRenderer.invoke('tickets:print', payload),
  },
  tables: {
    setOpen: (area: string, label: string, open: boolean) =>
      ipcRenderer.invoke('tables:setOpen', { area, label, open }),
    listOpen: () => ipcRenderer.invoke('tables:listOpen'),
    transfer: (input) => ipcRenderer.invoke('tables:transfer', input),
  },
  notifications: {
    list: (userId: number, onlyUnread?: boolean) =>
      ipcRenderer.invoke('notifications:list', { userId, onlyUnread }),
    markAllRead: (userId: number) =>
      ipcRenderer.invoke('notifications:markAllRead', { userId }),
  },
  requests: {
    create: (input: {
      requesterId: number;
      ownerId: number;
      area: string;
      tableLabel: string;
      items: any[];
      note?: string | null;
    }) => ipcRenderer.invoke('requests:create', input),
    listForOwner: (ownerId: number) =>
      ipcRenderer.invoke('requests:listForOwner', { ownerId }),
    approve: (id: number, ownerId: number) =>
      ipcRenderer.invoke('requests:approve', { id, ownerId }),
    reject: (id: number, ownerId: number) =>
      ipcRenderer.invoke('requests:reject', { id, ownerId }),
    pollApprovedForTable: (ownerId: number, area: string, tableLabel: string) =>
      ipcRenderer.invoke('requests:pollApprovedForTable', {
        ownerId,
        area,
        tableLabel,
      }),
    markApplied: (ids: number[]) =>
      ipcRenderer.invoke('requests:markApplied', { ids }),
  },
  network: {
    getIps: () => ipcRenderer.invoke('network:getIps'),
  },
  updater: {
    getUpdateStatus: () => ipcRenderer.invoke('updater:getStatus'),
    checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
    downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('updater:installUpdate'),
  },
};

declare global {
  interface Window {
    api: Api;
  }
}

process.once('loaded', () => {
  contextBridge.exposeInMainWorld('api', api);
});

// Force staff logout on auth/session expiry (main -> renderer)
ipcRenderer.on('auth:forceLogout', (_e, payload) => {
  try {
    const reason = (payload as any)?.reason;
    window.dispatchEvent(
      new CustomEvent('pos:forceLogout', { detail: { reason } }),
    );
  } catch {
    // ignore
  }
});

// Updater events (main -> renderer)
ipcRenderer.on('updater:event', (_e, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('updater:event', { detail: payload }));
  } catch {
    // ignore
  }
});

// Printer events (main -> renderer)
ipcRenderer.on('printer:event', (_e, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('printer:event', { detail: payload }));
  } catch {
    // ignore
  }
});
