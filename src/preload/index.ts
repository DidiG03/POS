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
  },
  layout: {
    get: (userId: number, area: string) => ipcRenderer.invoke('layout:get', { userId, area }),
    save: (userId: number, area: string, nodes: any[]) => ipcRenderer.invoke('layout:save', { userId, area, nodes }),
  },
  covers: {
    save: (area: string, label: string, covers: number) => ipcRenderer.invoke('covers:save', { area, label, covers }),
    getLast: (area: string, label: string) => ipcRenderer.invoke('covers:getLast', { area, label }),
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


