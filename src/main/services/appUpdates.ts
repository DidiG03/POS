/**
 * POS-side fleet updates: this till's electron-updater plus a LAN push
 * so kitchen displays check/install without visiting each KDS.
 *
 * Admin on another computer talks to these helpers over HTTP. Those calls
 * must return quickly — a 227MB Windows download cannot ride the Admin
 * client's 4s LAN timeout — so check/download are started and Admin polls
 * GET /admin/updates/status until `checking` / `downloading` clear.
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
  void updaterHandlers.checkForUpdates();
  return { success: true, started: true as const };
}

export async function downloadHostAndClients() {
  // Check first so kitchen displays (auto-download) start pulling, then
  // this till prepares its own package. Admin polls status; we return fast.
  broadcastAppsUpdate({ action: 'check' });
  const pos = updaterHandlers.getUpdateStatus();
  if (pos.downloaded) {
    broadcastAppsUpdate({ action: 'download' });
    return { success: true, downloaded: true };
  }
  void updaterHandlers.checkDownloadAndPrepare();
  broadcastAppsUpdate({ action: 'download' });
  return { success: true, started: true as const };
}

export async function installHostAndClients() {
  broadcastAppsUpdate({ action: 'install' });
  // Let SSE flush to KDS before this till quits to install.
  await delay(800);
  const pos = updaterHandlers.getUpdateStatus();
  if (!pos.downloaded) return { success: true, downloaded: false };
  return updaterHandlers.installUpdate();
}
