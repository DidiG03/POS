// Preload must be CommonJS-compatible. Avoid top-level ESM-only features.
import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '@shared/ipc';

const api: Api = {
  auth: {
    loginWithPin: (pin: string, userId?: number) => ipcRenderer.invoke('auth:loginWithPin', { pin, userId }),
    createUser: (input) => ipcRenderer.invoke('auth:createUser', input),
    listUsers: () => ipcRenderer.invoke('auth:listUsers'),
    updateUser: (input) => ipcRenderer.invoke('auth:updateUser', input),
    syncStaffFromApi: (url?: string) => ipcRenderer.invoke('auth:syncStaffFromApi', { url }),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (input) => ipcRenderer.invoke('settings:update', input),
    testPrint: () => ipcRenderer.invoke('settings:testPrint'),
    setPrinter: (input) => ipcRenderer.invoke('settings:setPrinter', input),
  },
  menu: {
    syncFromUrl: (input) => ipcRenderer.invoke('menu:syncFromUrl', input),
    listCategoriesWithItems: () => ipcRenderer.invoke('menu:listCategoriesWithItems'),
  },
  shifts: {
    getOpen: (userId: number) => ipcRenderer.invoke('shifts:getOpen', { userId }),
    clockIn: (userId: number) => ipcRenderer.invoke('shifts:clockIn', { userId }),
    clockOut: (userId: number) => ipcRenderer.invoke('shifts:clockOut', { userId }),
    listOpen: () => ipcRenderer.invoke('shifts:listOpen'),
  },
  admin: {
    getOverview: () => ipcRenderer.invoke('admin:getOverview'),
    openWindow: () => ipcRenderer.invoke('admin:openWindow'),
    listShifts: () => ipcRenderer.invoke('admin:listShifts'),
    listTicketCounts: (input?: { startIso?: string; endIso?: string }) => ipcRenderer.invoke('admin:listTicketCounts', input),
    listTicketsByUser: (userId: number, range?: { startIso?: string; endIso?: string }) =>
      ipcRenderer.invoke('admin:listTicketsByUser', { userId, ...(range || {}) }),
    listNotifications: (input?: { onlyUnread?: boolean; limit?: number }) => ipcRenderer.invoke('admin:listNotifications', input || {}),
    markAllNotificationsRead: () => ipcRenderer.invoke('admin:markAllNotificationsRead'),
    getTopSellingToday: () => ipcRenderer.invoke('admin:getTopSellingToday'),
    getSalesTrends: (input: { range: 'daily' | 'weekly' | 'monthly' }) => ipcRenderer.invoke('admin:getSalesTrends', input),
  },
  layout: {
    get: (userId: number, area: string) => ipcRenderer.invoke('layout:get', { userId, area }),
    save: (userId: number, area: string, nodes: any[]) => ipcRenderer.invoke('layout:save', { userId, area, nodes }),
  },
  covers: {
    save: (area: string, label: string, covers: number) => ipcRenderer.invoke('covers:save', { area, label, covers }),
    getLast: (area: string, label: string) => ipcRenderer.invoke('covers:getLast', { area, label }),
  },
  tickets: {
    log: (payload: any) => ipcRenderer.invoke('tickets:log', payload),
    getLatestForTable: (area: string, tableLabel: string) => ipcRenderer.invoke('tickets:getLatestForTable', { area, tableLabel }),
    voidItem: (payload: any) => ipcRenderer.invoke('tickets:voidItem', payload),
    voidTicket: (payload: any) => ipcRenderer.invoke('tickets:voidTicket', payload),
  },
  tables: {
    setOpen: (area: string, label: string, open: boolean) => ipcRenderer.invoke('tables:setOpen', { area, label, open }),
    listOpen: () => ipcRenderer.invoke('tables:listOpen'),
  },
  notifications: {
    list: (userId: number, onlyUnread?: boolean) => ipcRenderer.invoke('notifications:list', { userId, onlyUnread }),
    markAllRead: (userId: number) => ipcRenderer.invoke('notifications:markAllRead', { userId }),
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


