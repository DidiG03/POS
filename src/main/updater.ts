/**
 * Auto-updater for Electron app
 *
 * Supports multiple update servers:
 * - GitHub Releases (recommended for open source)
 * - Generic update server (custom URL)
 *
 * Configuration:
 * - GITHUB_OWNER: GitHub username/org (e.g., "yourusername")
 * - GITHUB_REPO: Repository name (e.g., "POS")
 * - UPDATE_SERVER_URL: Custom update server URL (alternative to GitHub)
 * - AUTO_UPDATE_ENABLED: Set to "false" to disable auto-updates (default: true)
 */

import { autoUpdater, UpdateInfo } from 'electron-updater';
import { BrowserWindow } from 'electron';
import { captureException, addBreadcrumb } from './services/sentry';

const IS_DEV =
  process.env.NODE_ENV !== 'production' || process.env.ELECTRON_IS_DEV === '1';
const AUTO_UPDATE_ENABLED = process.env.AUTO_UPDATE_ENABLED !== 'false';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const UPDATE_SERVER_URL = process.env.UPDATE_SERVER_URL || '';

let updateCheckInterval: NodeJS.Timeout | null = null;
let updateInfo: UpdateInfo | null = null;
let updateDownloaded = false;
let updateCheckListeners: Set<BrowserWindow> = new Set();

// Hands-off (kiosk) auto-update state. Only enabled for the KDS.
let autoInstallOnDownloaded = false;
let autoInstallDelayMs = 60_000;
let autoInstallTimer: NodeJS.Timeout | null = null;

function clearAutoInstallTimer(): void {
  if (autoInstallTimer) {
    clearTimeout(autoInstallTimer);
    autoInstallTimer = null;
  }
}

export type AutoUpdaterSetupOptions = {
  /** GitHub release channel. Omit for POS (`latest.yml`); use `kds` for KDS. */
  channel?: string;
  /**
   * Download the update automatically as soon as it's detected, without
   * waiting for a user click. Used by the KDS kiosk so an unattended
   * kitchen display fetches new versions on its own. POS keeps the
   * manual "Download" button (default false).
   */
  autoDownload?: boolean;
  /**
   * After the download finishes, automatically restart-and-install once
   * the grace period elapses. The renderer shows a deferrable countdown
   * so staff can postpone an install during a busy service. Used by the
   * KDS kiosk; POS leaves this off and relies on the explicit button.
   */
  autoInstallOnDownloaded?: boolean;
  /** Grace period before the automatic install fires. Default 60s. */
  autoInstallDelayMs?: number;
};

function releaseDateIso(releaseDate: unknown): string | undefined {
  if (!releaseDate) return undefined;
  if (typeof releaseDate === 'string') return releaseDate;
  if (releaseDate instanceof Date) return releaseDate.toISOString();
  try {
    // Some providers may give a Date-like object
    const d = new Date(releaseDate as any);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

// IPC handlers will be registered in main/index.ts
export const updaterHandlers = {
  getUpdateStatus: () => {
    return {
      hasUpdate: updateInfo !== null,
      updateInfo: updateInfo
        ? {
            version: updateInfo.version,
            releaseDate: releaseDateIso((updateInfo as any).releaseDate),
            releaseNotes: updateInfo.releaseNotes || '',
          }
        : null,
      downloaded: updateDownloaded,
      checking: false,
    };
  },
  checkForUpdates: async () => {
    if (!AUTO_UPDATE_ENABLED) {
      return { error: 'Auto-updates are disabled' };
    }
    if (IS_DEV) {
      return { error: 'Updates are disabled in development mode' };
    }
    try {
      addBreadcrumb('Checking for updates', 'updater', 'info');
      await autoUpdater.checkForUpdates();
      return { success: true };
    } catch (error: any) {
      captureException(
        error instanceof Error ? error : new Error(String(error)),
        { context: 'updater:checkForUpdates' },
      );
      return { error: error?.message || 'Failed to check for updates' };
    }
  },
  downloadUpdate: async () => {
    if (!updateInfo) {
      return { error: 'No update available' };
    }
    try {
      addBreadcrumb('Downloading update', 'updater', 'info');
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error: any) {
      captureException(
        error instanceof Error ? error : new Error(String(error)),
        { context: 'updater:downloadUpdate' },
      );
      return { error: error?.message || 'Failed to download update' };
    }
  },
  installUpdate: () => {
    if (!updateDownloaded) {
      return { error: 'Update not downloaded yet' };
    }
    clearAutoInstallTimer();
    addBreadcrumb('Installing update and restarting', 'updater', 'info');
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  },
  /**
   * Cancel a pending automatic install (the deferrable kiosk countdown).
   * The update stays downloaded and `autoInstallOnAppQuit` still applies,
   * so it installs the next time the app is closed.
   */
  deferInstall: () => {
    clearAutoInstallTimer();
    addBreadcrumb('Auto-install deferred by user', 'updater', 'info');
    notifyListeners('auto-install-deferred');
    return { success: true };
  },
};

export function setupAutoUpdater(options?: AutoUpdaterSetupOptions): void {
  if (!AUTO_UPDATE_ENABLED) {
    console.log('[AutoUpdater] Disabled (AUTO_UPDATE_ENABLED=false)');
    return;
  }

  if (IS_DEV) {
    console.log('[AutoUpdater] Disabled in development mode');
    return;
  }

  try {
    // Configure update server
    if (GITHUB_OWNER && GITHUB_REPO) {
      const feed: {
        provider: 'github';
        owner: string;
        repo: string;
        channel?: string;
      } = {
        provider: 'github',
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
      };
      if (options?.channel) feed.channel = options.channel;
      autoUpdater.setFeedURL(feed);
      console.log(
        `[AutoUpdater] Configured for GitHub: ${GITHUB_OWNER}/${GITHUB_REPO}` +
          (options?.channel ? ` (channel: ${options.channel})` : ''),
      );
    } else if (UPDATE_SERVER_URL) {
      // Custom update server
      autoUpdater.setFeedURL(UPDATE_SERVER_URL);
      console.log(
        `[AutoUpdater] Configured for custom server: ${UPDATE_SERVER_URL}`,
      );
    } else {
      console.warn(
        '[AutoUpdater] No update server configured. Set GITHUB_OWNER/GITHUB_REPO or UPDATE_SERVER_URL',
      );
      return;
    }

    // Configuration
    autoUpdater.autoDownload = Boolean(options?.autoDownload); // KDS: true; POS: false (manual)
    autoUpdater.autoInstallOnAppQuit = true; // Auto-install on quit if downloaded
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false; // Only stable releases

    autoInstallOnDownloaded = Boolean(options?.autoInstallOnDownloaded);
    if (
      typeof options?.autoInstallDelayMs === 'number' &&
      Number.isFinite(options.autoInstallDelayMs) &&
      options.autoInstallDelayMs >= 0
    ) {
      autoInstallDelayMs = options.autoInstallDelayMs;
    }

    // Event handlers
    autoUpdater.on('checking-for-update', () => {
      console.log('[AutoUpdater] Checking for update...');
      notifyListeners('checking');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('[AutoUpdater] Update available:', info.version);
      updateInfo = info;
      updateDownloaded = false;
      notifyListeners('update-available', {
        version: info.version,
        releaseDate: releaseDateIso((info as any).releaseDate),
        releaseNotes: info.releaseNotes || '',
      });
      addBreadcrumb(`Update available: ${info.version}`, 'updater', 'info');
      // Kiosk path: pull the update down immediately so the only remaining
      // step is the (auto-scheduled) restart. `autoDownload` already does
      // this internally, but calling it explicitly keeps behavior obvious
      // and works even if a future electron-updater changes the default.
      if (autoUpdater.autoDownload) {
        autoUpdater.downloadUpdate().catch((error) => {
          captureException(
            error instanceof Error ? error : new Error(String(error)),
            { context: 'updater:autoDownload' },
          );
        });
      }
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      console.log(
        '[AutoUpdater] No update available. Current version:',
        info.version,
      );
      updateInfo = null;
      updateDownloaded = false;
      notifyListeners('update-not-available');
    });

    autoUpdater.on('error', (error: Error) => {
      console.error('[AutoUpdater] Error:', error);
      captureException(error, { context: 'updater:error' });
      notifyListeners('error', { message: error.message });
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent || 0);
      console.log(`[AutoUpdater] Download progress: ${percent}%`);
      notifyListeners('download-progress', {
        percent,
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('[AutoUpdater] Update downloaded:', info.version);
      updateDownloaded = true;
      notifyListeners('update-downloaded', {
        version: info.version,
        releaseDate: releaseDateIso((info as any).releaseDate),
        releaseNotes: info.releaseNotes || '',
      });
      addBreadcrumb(`Update downloaded: ${info.version}`, 'updater', 'info');

      // Kiosk path: schedule an automatic restart-and-install after a
      // grace period. The renderer shows a deferrable countdown so staff
      // can postpone it mid-service; if nobody intervenes the kitchen
      // display updates itself with zero manual steps.
      if (autoInstallOnDownloaded) {
        clearAutoInstallTimer();
        const installAtMs = Date.now() + autoInstallDelayMs;
        notifyListeners('auto-install-scheduled', {
          version: info.version,
          delayMs: autoInstallDelayMs,
          installAtMs,
        });
        autoInstallTimer = setTimeout(() => {
          autoInstallTimer = null;
          addBreadcrumb(
            `Auto-installing update: ${info.version}`,
            'updater',
            'info',
          );
          try {
            autoUpdater.quitAndInstall(true, true);
          } catch (error) {
            captureException(
              error instanceof Error ? error : new Error(String(error)),
              { context: 'updater:autoInstall' },
            );
          }
        }, autoInstallDelayMs);
      }
    });

    // Check for updates on startup (after a delay to not block app launch)
    setTimeout(() => {
      checkForUpdates();
    }, 5000); // 5 seconds after app start

    // Check for updates periodically (every 4 hours)
    updateCheckInterval = setInterval(
      () => {
        checkForUpdates();
      },
      4 * 60 * 60 * 1000,
    ); // 4 hours

    console.log('[AutoUpdater] Initialized successfully');
  } catch (error) {
    console.error('[AutoUpdater] Initialization failed:', error);
    captureException(
      error instanceof Error ? error : new Error(String(error)),
      { context: 'updater:init' },
    );
  }
}

async function checkForUpdates(): Promise<void> {
  if (!AUTO_UPDATE_ENABLED || IS_DEV) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // Errors are handled by the 'error' event handler
    void error;
  }
}

function notifyListeners(event: string, data?: any): void {
  // Notify all registered windows
  for (const window of updateCheckListeners) {
    if (!window.isDestroyed()) {
      window.webContents.send('updater:event', { event, data });
    }
  }
  // Clean up destroyed windows
  updateCheckListeners = new Set(
    Array.from(updateCheckListeners).filter((w) => !w.isDestroyed()),
  );
}

export function registerUpdateListener(window: BrowserWindow): void {
  updateCheckListeners.add(window);
  window.on('closed', () => {
    updateCheckListeners.delete(window);
  });
}

export function unregisterUpdateListener(window: BrowserWindow): void {
  updateCheckListeners.delete(window);
}

export function cleanup(): void {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
  clearAutoInstallTimer();
  updateCheckListeners.clear();
}
