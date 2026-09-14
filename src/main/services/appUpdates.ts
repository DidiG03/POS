/**
 * POS-side fleet updates: this till's electron-updater plus a LAN push
 * so kitchen displays check/install without visiting each KDS.
 */
import { app } from 'electron';
import { updaterHandlers } from '../updater';
import { broadcastAppsUpdate } from './realtime';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getHostUpdateStatus() {
  return {
    app: 'pos' as const,
    ...updaterHandlers.getUpdateStatus(),
    currentVersion: app.getVersion(),
  };
}

export async function checkHostAndClients() {
  broadcastAppsUpdate({ action: 'check' });
  return updaterHandlers.checkForUpdates();
}

export async function downloadHostAndClients() {
  broadcastAppsUpdate({ action: 'download' });
  const pos = updaterHandlers.getUpdateStatus();
  if (!pos.hasUpdate) return { success: true };
  return updaterHandlers.downloadUpdate();
}

export async function installHostAndClients() {
  broadcastAppsUpdate({ action: 'install' });
  // Let SSE flush to KDS before this till quits to install.
  await delay(800);
  const pos = updaterHandlers.getUpdateStatus();
  if (!pos.downloaded) return { success: true };
  return updaterHandlers.installUpdate();
}
