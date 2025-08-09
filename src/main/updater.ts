import { autoUpdater } from 'electron-updater';

export function setupAutoUpdater() {
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.on('error', (e) => console.warn('Updater error', e));
    // Stub: In production, set feedURL and call checkForUpdates()
  } catch (e) {
    console.warn('AutoUpdater not initialized', e);
  }
}


