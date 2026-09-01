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
    resumeSession: (token: string) =>
      ipcRenderer.invoke('auth:resumeSession', { token }),
    endSession: () => ipcRenderer.invoke('auth:endSession'),
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
    testPrintProfile: (profile) =>
      ipcRenderer.invoke('settings:testPrintProfile', profile),
    testFiscalConnection: () =>
      ipcRenderer.invoke('settings:testFiscalConnection'),
    getFiscalTokenHint: () => ipcRenderer.invoke('settings:getFiscalTokenHint'),
    testFiscalMinimalInvoice: () =>
      ipcRenderer.invoke('settings:testFiscalMinimalInvoice'),
    listFiscalReviews: () => ipcRenderer.invoke('settings:listFiscalReviews'),
    resolveFiscalReview: (input) =>
      ipcRenderer.invoke('settings:resolveFiscalReview', input),
    syncGoogleCalendar: () => ipcRenderer.invoke('settings:syncGoogleCalendar'),
    connectGoogleCalendar: () =>
      ipcRenderer.invoke('settings:connectGoogleCalendar'),
    disconnectGoogleCalendar: () =>
      ipcRenderer.invoke('settings:disconnectGoogleCalendar'),
    getGoogleCalendarStatus: () =>
      ipcRenderer.invoke('settings:getGoogleCalendarStatus'),
    listGoogleCalendars: () =>
      ipcRenderer.invoke('settings:listGoogleCalendars'),
    listPrinters: () => ipcRenderer.invoke('printer:list'),
    scanNetworkPrinters: () => ipcRenderer.invoke('printer:scanNetwork'),
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
    listNotifications: (input?: {
      userId?: number;
      onlyUnread?: boolean;
      limit?: number;
    }) => ipcRenderer.invoke('admin:listNotifications', input || {}),
    markAllNotificationsRead: (input?: { userId?: number }) =>
      ipcRenderer.invoke('admin:markAllNotificationsRead', input || {}),
    getTopSellingToday: () => ipcRenderer.invoke('admin:getTopSellingToday'),
    getSalesTrends: (input: { range: 'daily' | 'weekly' | 'monthly' }) =>
      ipcRenderer.invoke('admin:getSalesTrends', input),
    getSecurityLog: (limit?: number) =>
      ipcRenderer.invoke('admin:getSecurityLog', { limit }),
    getReview: (input) => ipcRenderer.invoke('admin:getReview', input),
  },
  kds: {
    openWindow: () => ipcRenderer.invoke('kds:openWindow'),
    listTickets: (input: {
      station: 'KITCHEN' | 'BAR' | 'DESSERT';
      status: 'NEW' | 'DONE';
      limit?: number;
      cooker?: boolean;
    }) => ipcRenderer.invoke('kds:listTickets', input),
    bump: (input: {
      station: 'KITCHEN' | 'BAR' | 'DESSERT';
      ticketId: number;
      userId?: number;
      cooker?: boolean;
    }) => ipcRenderer.invoke('kds:bump', input),
    recall: (input: {
      station: 'KITCHEN' | 'BAR' | 'DESSERT';
      ticketId?: number;
      itemIdx?: number;
    }) => ipcRenderer.invoke('kds:recall', input),
    bumpItem: (input: {
      station: 'KITCHEN' | 'BAR' | 'DESSERT';
      ticketId: number;
      itemIdx: number;
      userId?: number;
      cooker?: boolean;
    }) => ipcRenderer.invoke('kds:bumpItem', input),
    clearDone: (input: { station: 'KITCHEN' | 'BAR' | 'DESSERT' }) =>
      ipcRenderer.invoke('kds:clearDone', input),
    getTicketDetail: (input: { ticketId: number }) =>
      ipcRenderer.invoke('kds:getTicketDetail', input),
    getCookerMode: () => ipcRenderer.invoke('kds:getCookerMode'),
    setCookerMode: (input: { enabled: boolean }) =>
      ipcRenderer.invoke('kds:setCookerMode', input),
    getEnabledStations: () => ipcRenderer.invoke('kds:getEnabledStations'),
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
    listMyVoidedTickets: (input: { userId: number; limit?: number }) =>
      ipcRenderer.invoke('reports:listMyVoidedTickets', input),
  },
  offline: {
    getStatus: () => ipcRenderer.invoke('offline:getStatus'),
  },
  license: {
    getStatus: () => ipcRenderer.invoke('license:getStatus'),
    createCheckout: (input: { email: string }) =>
      ipcRenderer.invoke('license:createCheckout', input),
    activateSession: (input: { sessionId: string }) =>
      ipcRenderer.invoke('license:activateSession', input),
    activateKey: (input: { key: string }) =>
      ipcRenderer.invoke('license:activateKey', input),
    restore: (input: { email: string }) =>
      ipcRenderer.invoke('license:restore', input),
    createPortalSession: () =>
      ipcRenderer.invoke('license:createPortalSession'),
    onUpdated: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on('license:updated', listener);
      return () => {
        ipcRenderer.removeListener('license:updated', listener);
      };
    },
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
    get: (userId: number, area: string, scope?: string) =>
      ipcRenderer.invoke('layout:get', { userId, area, scope }),
    save: (userId: number, area: string, nodes: any[], scope?: string) =>
      ipcRenderer.invoke('layout:save', { userId, area, nodes, scope }),
    getMerges: (area: string) =>
      ipcRenderer.invoke('layout:getMerges', { area }),
    setMerges: (area: string, groups) =>
      ipcRenderer.invoke('layout:setMerges', { area, groups }),
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
    listPaidTables: (input: { dateIso: string }) =>
      ipcRenderer.invoke('tickets:listPaidTables', input),
    print: (payload: any) => ipcRenderer.invoke('tickets:print', payload),
  },
  print: {
    listRetries: () => ipcRenderer.invoke('print:listRetries'),
    cancelRetry: (id: number) =>
      ipcRenderer.invoke('print:cancelRetry', { id }),
  },
  tables: {
    setOpen: (area: string, label: string, open: boolean) =>
      ipcRenderer.invoke('tables:setOpen', { area, label, open }),
    listOpen: () => ipcRenderer.invoke('tables:listOpen'),
    getFloorSnapshot: (area?: string) =>
      ipcRenderer.invoke('tables:getFloorSnapshot', { area }),
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
  reservations: {
    openWindow: () => ipcRenderer.invoke('reservations:openWindow'),
    list: (input) => ipcRenderer.invoke('reservations:list', input),
    create: (input) => ipcRenderer.invoke('reservations:create', input),
    update: (input) => ipcRenderer.invoke('reservations:update', input),
    delete: (input) => ipcRenderer.invoke('reservations:delete', input),
    setStatus: (input) => ipcRenderer.invoke('reservations:setStatus', input),
    listCounts: (input) => ipcRenderer.invoke('reservations:listCounts', input),
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

// Reservation real-time events (main -> renderer). Fired whenever a
// reservation is created / updated / status-changed / deleted by any
// client (this Electron window, another Electron window, or a mobile
// tablet via the LAN HTTP API). Reservation pages listen for this on
// `window` and refetch their visible day.
ipcRenderer.on('reservations:changed', (_e, payload) => {
  try {
    window.dispatchEvent(
      new CustomEvent('pos:reservationsChanged', { detail: payload }),
    );
  } catch {
    // ignore
  }
});

// Table-status real-time events (main -> renderer). Fired whenever any
// client opens or closes a table. The TablesPage listens for this on
// `window` and updates its open-status map without waiting for the
// 15s poll, keeping floor colours in sync across every window/tablet.
ipcRenderer.on('tables:changed', (_e, payload) => {
  try {
    window.dispatchEvent(
      new CustomEvent('pos:tablesChanged', { detail: payload }),
    );
  } catch {
    // ignore
  }
});

// Tickets real-time events (main -> renderer). Fired whenever any client
// writes a new TicketLog row. The TablesPage listens for this and
// re-fetches the per-table waiter badge / metrics for the affected
// table, so when waiter A appends an item to a table that waiter B
// already had open, every other device flips the badge to A immediately
// instead of waiting for the next badge-refresh cycle.
ipcRenderer.on('tickets:changed', (_e, payload) => {
  try {
    window.dispatchEvent(
      new CustomEvent('pos:ticketsChanged', { detail: payload }),
    );
  } catch {
    // ignore
  }
});

// Floor-layout real-time events (main -> renderer). Fired whenever an
// admin saves the shared floor layout for an area. Waiter and Host
// floor pages refetch on receipt so a saved change appears on every
// device without a refresh.
ipcRenderer.on('layout:changed', (_e, payload) => {
  try {
    window.dispatchEvent(
      new CustomEvent('pos:layoutChanged', { detail: payload }),
    );
  } catch {
    // ignore
  }
});

ipcRenderer.on('tableMerges:changed', (_e, payload) => {
  try {
    window.dispatchEvent(
      new CustomEvent('pos:tableMergesChanged', { detail: payload }),
    );
  } catch {
    // ignore
  }
});
