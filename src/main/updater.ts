/**
 * Auto-updater for Electron app
 *
 * Supports multiple update servers:
 * - GitHub Releases (generic `/releases/latest/download` feed)
 * - Generic update server (custom URL)
 *
 * Configuration:
 * - GITHUB_OWNER: GitHub username/org (e.g., "yourusername")
 * - GITHUB_REPO: Repository name (e.g., "POS")
 * - UPDATE_SERVER_URL: Custom update server URL (alternative to GitHub)
 * - AUTO_UPDATE_ENABLED: Set to "false" to disable auto-updates (default: true)
 */

import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { captureException, addBreadcrumb } from './services/sentry';
import { allowNextQuit } from './services/hostRuntime';
import { isUnpackagedElectron } from './services/electronDev';
import { resolveUpdateFeed } from './services/updateFeed';
import {
  isMissingUpdateFeedError,
  userFacingUpdaterError,
} from '@shared/updateFeedError';

const IS_DEV = isUnpackagedElectron(
  app.isPackaged,
  process.env.ELECTRON_IS_DEV,
);
const AUTO_UPDATE_ENABLED = process.env.AUTO_UPDATE_ENABLED !== 'false';

let updateCheckInterval: NodeJS.Timeout | null = null;
let updateInfo: UpdateInfo | null = null;
let updateDownloaded = false;
let checking = false;
let downloading = false;
let downloadPercent: number | null = null;
let updateCheckListeners: Set<BrowserWindow> = new Set();
let initialized = false;
let inFlightCheck: Promise<UpdateCheckResult> | null = null;
let inFlightDownload: Promise<UpdateActionResult> | null = null;
const statusListeners = new Set<() => void>();

// Hands-off (kiosk) auto-update state. Only enabled for the KDS.
let autoInstallOnDownloaded = false;
let autoInstallDelayMs = 60_000;
let autoInstallTimer: NodeJS.Timeout | null = null;

export type UpdateActionResult = {
  success?: boolean;
  error?: string;
  hasUpdate?: boolean;
  downloaded?: boolean;
  currentVersion?: string;
  updateInfo?: {
    version: string;
    releaseDate?: string;
    releaseNotes?: string | unknown;
  } | null;
};

type UpdateCheckResult = UpdateActionResult;

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

function snapshotUpdateInfo(info: UpdateInfo | null) {
  if (!info) return null;
  return {
    version: info.version,
    releaseDate: releaseDateIso((info as any).releaseDate),
    releaseNotes: info.releaseNotes || '',
  };
}

function currentVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '';
  }
}

function emitStatusChange(): void {
  for (const listener of statusListeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

export function onUpdaterStatusChange(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function isAlreadyInProgressError(error: unknown): boolean {
  const msg = String((error as any)?.message || error || '');
  return /already in progress|checking for update/i.test(msg);
}

function beginDownload(): Promise<UpdateActionResult> {
  if (updateDownloaded)
    return Promise.resolve({ success: true, downloaded: true });
  if (inFlightDownload) return inFlightDownload;
  downloading = true;
  if (downloadPercent == null) downloadPercent = 0;
  emitStatusChange();
  inFlightDownload = (async () => {
    try {
      addBreadcrumb('Downloading update', 'updater', 'info');
      await autoUpdater.downloadUpdate();
      return { success: true, downloaded: true };
    } catch (error: any) {
      if (updateDownloaded) return { success: true, downloaded: true };
      captureException(
        error instanceof Error ? error : new Error(String(error)),
        { context: 'updater:downloadUpdate' },
      );
      return {
        error: userFacingUpdaterError(error) || 'Failed to download update',
      };
    } finally {
      downloading = false;
      inFlightDownload = null;
    }
  })();
  return inFlightDownload;
}

/**
 * NSIS on Windows needs a silent installer: a UI installer waits on this
 * process while the process waits on the installer. macOS replaces the .app
 * from the zip and relaunches. Always confirm quit so the tray host does
 * not intercept the restart.
 */
function quitAndInstallUpdate(): void {
  allowNextQuit();
  try {
    app.releaseSingleInstanceLock();
  } catch {
    // ignore
  }
  const silent = process.platform === 'win32';
  autoUpdater.quitAndInstall(silent, true);
}

async function performCheck(): Promise<UpdateCheckResult> {
  const version = currentVersion();
  if (!AUTO_UPDATE_ENABLED) {
    return { error: 'Auto-updates are disabled', currentVersion: version };
  }
  if (IS_DEV) {
    return {
      error: 'Updates are disabled in development mode',
      currentVersion: version,
    };
  }
  if (!initialized) {
    return { error: 'Updater is not ready', currentVersion: version };
  }

  checking = true;
  emitStatusChange();
  notifyListeners('checking');
  addBreadcrumb('Checking for updates', 'updater', 'info');
  try {
    await autoUpdater.checkForUpdates();
    return {
      success: true,
      hasUpdate: updateInfo !== null,
      downloaded: updateDownloaded,
      currentVersion: version,
      updateInfo: snapshotUpdateInfo(updateInfo),
    };
  } catch (error: any) {
    if (isMissingUpdateFeedError(error)) {
      updateInfo = null;
      updateDownloaded = false;
      notifyListeners('update-not-available');
      return { success: true, hasUpdate: false, currentVersion: version };
    }
    if (isAlreadyInProgressError(error)) {
      return {
        success: true,
        hasUpdate: updateInfo !== null,
        downloaded: updateDownloaded,
        currentVersion: version,
        updateInfo: snapshotUpdateInfo(updateInfo),
      };
    }
    captureException(
      error instanceof Error ? error : new Error(String(error)),
      { context: 'updater:checkForUpdates' },
    );
    return { error: userFacingUpdaterError(error), currentVersion: version };
  } finally {
    checking = false;
    emitStatusChange();
  }
}

// IPC handlers will be registered in main/index.ts
export const updaterHandlers = {
  getUpdateStatus: () => {
    return {
      hasUpdate: updateInfo !== null,
      updateInfo: snapshotUpdateInfo(updateInfo),
      downloaded: updateDownloaded,
      checking,
      downloading: downloading || downloadPercent !== null,
      downloadPercent,
      currentVersion: currentVersion(),
    };
  },
  checkForUpdates: async () => {
    if (inFlightCheck) return inFlightCheck;
    checking = true;
    emitStatusChange();
    inFlightCheck = performCheck().finally(() => {
      inFlightCheck = null;
    });
    return inFlightCheck;
  },
  downloadUpdate: async () => {
    if (!updateInfo && !updateDownloaded) {
      return { error: 'No update available' };
    }
    return beginDownload();
  },
  /**
   * Check, download if needed, and leave the package ready to install.
   * Used by the native menu so one click does the whole pipeline.
   */
  checkDownloadAndPrepare: async (): Promise<UpdateActionResult> => {
    const version = currentVersion();
    if (updateDownloaded) {
      return {
        success: true,
        hasUpdate: true,
        downloaded: true,
        currentVersion: version,
        updateInfo: snapshotUpdateInfo(updateInfo),
      };
    }
    const checked = await updaterHandlers.checkForUpdates();
    if (checked.error) return checked;
    if (!checked.hasUpdate) {
      return {
        success: true,
        hasUpdate: false,
        downloaded: false,
        currentVersion: version,
      };
    }
    const downloaded = await beginDownload();
    if (downloaded.error) return downloaded;
    return {
      success: true,
      hasUpdate: true,
      downloaded: true,
      currentVersion: version,
      updateInfo: snapshotUpdateInfo(updateInfo),
    };
  },
  installUpdate: () => {
    if (!updateDownloaded) {
      return { error: 'Update not downloaded yet' };
    }
    clearAutoInstallTimer();
    addBreadcrumb('Installing update and restarting', 'updater', 'info');
    quitAndInstallUpdate();
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
  if (initialized) return;

  if (!AUTO_UPDATE_ENABLED) {
    console.log('[AutoUpdater] Disabled (AUTO_UPDATE_ENABLED=false)');
    return;
  }

  if (IS_DEV) {
    console.log('[AutoUpdater] Disabled in development mode');
    return;
  }

  try {
    // Read feed config at call time (NOT as module-level consts): the KDS
    // sets GITHUB_OWNER/REPO via ensurePackagedDefaults() at startup, which
    // runs AFTER this module is first imported — so module-level consts would
    // capture empty strings. Reading here guarantees we see the resolved env.
    const githubOwner = (process.env.GITHUB_OWNER || '').trim();
    const githubRepo = (process.env.GITHUB_REPO || '').trim();
    const updateServerUrl = (process.env.UPDATE_SERVER_URL || '').trim();

    // The channel always applies (works with an explicit feed OR with the
    // bundled app-update.yml that electron-builder ships from the publish
    // config). For KDS this is "kds" so it reads kds.yml / kds-mac.yml.
    if (options?.channel) {
      autoUpdater.channel = options.channel;
    }

    const feed = resolveUpdateFeed({
      githubOwner,
      githubRepo,
      updateServerUrl,
      channel: options?.channel,
    });
    if (feed) {
      autoUpdater.setFeedURL(feed);
      console.log(
        `[AutoUpdater] Configured generic feed: ${feed.url}` +
          (feed.channel ? ` (channel: ${feed.channel})` : ''),
      );
    } else {
      // No explicit feed: fall back to the bundled app-update.yml that
      // electron-builder generates from the publish config. Don't bail —
      // this is the normal unpackaged-override path.
      console.log(
        '[AutoUpdater] Using bundled app-update.yml feed' +
          (options?.channel ? ` (channel: ${options.channel})` : ''),
      );
    }

    autoUpdater.logger = console;
    // Configuration
    autoUpdater.autoDownload = Boolean(options?.autoDownload); // KDS: true; POS: false (manual)
    autoUpdater.autoInstallOnAppQuit = true; // Auto-install on quit if downloaded
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false; // Only stable releases
    // Windows blockmaps were missing from older GitHub releases; a failed
    // delta must not abort the whole update. Full NSIS / zip still apply.
    if (process.platform === 'win32') {
      (autoUpdater as any).disableDifferentialDownload = true;
    }

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
      checking = true;
      emitStatusChange();
      notifyListeners('checking');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('[AutoUpdater] Update available:', info.version);
      updateInfo = info;
      updateDownloaded = false;
      checking = false;
      emitStatusChange();
      notifyListeners('update-available', snapshotUpdateInfo(info));
      addBreadcrumb(`Update available: ${info.version}`, 'updater', 'info');
      // Kiosk path: pull the update down immediately so the only remaining
      // step is the (auto-scheduled) restart. `autoDownload` already does
      // this internally, but calling it explicitly keeps behavior obvious
      // and works even if a future electron-updater changes the default.
      if (autoUpdater.autoDownload) {
        void beginDownload().then((result) => {
          if (result.error) {
            captureException(new Error(result.error), {
              context: 'updater:autoDownload',
            });
          }
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
      checking = false;
      emitStatusChange();
      notifyListeners('update-not-available');
    });

    autoUpdater.on('error', (error: Error) => {
      checking = false;
      downloading = false;
      downloadPercent = null;
      emitStatusChange();
      if (isMissingUpdateFeedError(error)) {
        console.log('[AutoUpdater] No update feed on this release');
        notifyListeners('update-not-available');
        return;
      }
      console.error('[AutoUpdater] Error:', error);
      captureException(error, { context: 'updater:error' });
      notifyListeners('error', { message: userFacingUpdaterError(error) });
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent || 0);
      downloadPercent = percent;
      emitStatusChange();
      console.log(`[AutoUpdater] Download progress: ${percent}%`);
      notifyListeners('download-progress', {
        percent,
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('[AutoUpdater] Update downloaded:', info.version);
      updateInfo = info;
      updateDownloaded = true;
      downloadPercent = null;
      checking = false;
      emitStatusChange();
      notifyListeners('update-downloaded', snapshotUpdateInfo(info));
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
            quitAndInstallUpdate();
          } catch (error) {
            captureException(
              error instanceof Error ? error : new Error(String(error)),
              { context: 'updater:autoInstall' },
            );
          }
        }, autoInstallDelayMs);
      }
    });

    initialized = true;

    // Check for updates on startup (after a delay to not block app launch)
    setTimeout(() => {
      void checkForUpdates();
    }, 5000); // 5 seconds after app start

    // Check for updates periodically (every 4 hours)
    updateCheckInterval = setInterval(
      () => {
        void checkForUpdates();
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
    await updaterHandlers.checkForUpdates();
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
  statusListeners.clear();
}
