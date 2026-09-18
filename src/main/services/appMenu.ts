/**
 * Native application menu with a Check for Updates item that actually
 * checks, downloads, and offers to restart-and-install (Windows + macOS).
 */
import { Menu, app, dialog, BrowserWindow, clipboard } from 'electron';
import { onUpdaterStatusChange, updaterHandlers } from '../updater';
import { buildAppMenuTemplate, type AppMenuPlatform } from './appMenuTemplate';
import { listLanIpv4Addresses } from './lanHost';

export { buildAppMenuTemplate, updateMenuLabel } from './appMenuTemplate';
export type { AppMenuPlatform } from './appMenuTemplate';

let menuCheckRunning = false;
let menuInstalled = false;
let fleetMenuTimeout: ReturnType<typeof setTimeout> | null = null;

function menuPlatform(): AppMenuPlatform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

function parentWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && focused.isVisible()) return focused;
  const open = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.isVisible(),
  );
  return open;
}

async function showBox(
  boxOpts: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  const parent = parentWindow();
  return parent
    ? dialog.showMessageBox(parent, boxOpts)
    : dialog.showMessageBox(boxOpts);
}

function isAdminShell(): boolean {
  try {
    return /admin/i.test(app.getName());
  } catch {
    return false;
  }
}

export function finishMenuCheck(): void {
  if (fleetMenuTimeout) {
    clearTimeout(fleetMenuTimeout);
    fleetMenuTimeout = null;
  }
  menuCheckRunning = false;
  refreshAppMenu();
}

export async function checkForUpdatesFromMenu(): Promise<void> {
  if (menuCheckRunning) return;
  menuCheckRunning = true;
  refreshAppMenu();
  if (isAdminShell()) {
    const win = parentWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:run-fleet-check');
      fleetMenuTimeout = setTimeout(
        () => {
          fleetMenuTimeout = null;
          if (menuCheckRunning) finishMenuCheck();
        },
        15 * 60 * 1000,
      );
      return;
    }
  }
  try {
    const before = updaterHandlers.getUpdateStatus();
    if (before.downloaded) {
      const confirm = await showBox({
        type: 'info',
        buttons: ['Restart and Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: 'Update ready to install',
        detail: before.updateInfo?.version
          ? `Version ${before.updateInfo.version} is downloaded. ${app.getName()} will restart to finish installing.`
          : `${app.getName()} will restart to finish installing the update.`,
      });
      if (confirm.response === 0) {
        const installed = updaterHandlers.installUpdate();
        if (installed.error) {
          await showBox({
            type: 'error',
            message: 'Could not install the update',
            detail: installed.error,
          });
        }
      }
      return;
    }

    const result = await updaterHandlers.checkDownloadAndPrepare();
    if (result.error) {
      const dev = /disabled in development/i.test(result.error);
      await showBox({
        type: dev ? 'info' : 'error',
        message: dev
          ? 'Updates are disabled in development'
          : 'Could not check for updates',
        detail: dev
          ? `${app.getName()} ${result.currentVersion || app.getVersion()} is running from source. Packaged Windows and macOS builds check GitHub Releases.`
          : result.error,
      });
      return;
    }

    if (!result.hasUpdate) {
      await showBox({
        type: 'info',
        message: 'You’re up to date',
        detail: `${app.getName()} ${result.currentVersion || app.getVersion()} is the latest version.`,
      });
      return;
    }

    const version = result.updateInfo?.version;
    const confirm = await showBox({
      type: 'info',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: version
        ? `Version ${version} is ready to install`
        : 'Update ready to install',
      detail: /POS/i.test(app.getName())
        ? `${app.getName()} will restart to apply the update. Tablets stay disconnected until this computer comes back.`
        : `${app.getName()} will restart to apply the update.`,
    });
    if (confirm.response === 0) {
      const installed = updaterHandlers.installUpdate();
      if (installed.error) {
        await showBox({
          type: 'error',
          message: 'Could not install the update',
          detail: installed.error,
        });
      }
    }
  } catch (error) {
    await showBox({
      type: 'error',
      message: 'Could not check for updates',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    finishMenuCheck();
  }
}

export async function showTillAddressFromMenu(): Promise<void> {
  const ips = listLanIpv4Addresses().filter((ip) => !ip.startsWith('169.254.'));
  const lines = ips.length
    ? ips.map((ip) => `${ip}:3333`)
    : [
        'This computer has no Wi-Fi address yet. Connect it to the store network, then open this again.',
      ];
  const detail = `${lines.join('\n')}\n\nIn OneTap Admin, scan for this till or type one of these addresses. Waiter tablets use the same Wi-Fi.`;
  const confirm = await showBox({
    type: 'info',
    buttons: ips.length ? ['Copy Address', 'OK'] : ['OK'],
    defaultId: ips.length ? 1 : 0,
    cancelId: ips.length ? 1 : 0,
    noLink: true,
    message: 'This till’s address',
    detail,
  });
  if (ips.length && confirm.response === 0) {
    try {
      clipboard.writeText(lines[0] || '');
    } catch {
      // ignore
    }
  }
}

function refreshAppMenu(): void {
  const status = updaterHandlers.getUpdateStatus();
  const template = buildAppMenuTemplate({
    platform: menuPlatform(),
    appName: app.getName(),
    version: status.currentVersion || app.getVersion(),
    checking: Boolean(status.checking) || menuCheckRunning,
    downloading: Boolean(status.downloading),
    downloadPercent:
      typeof status.downloadPercent === 'number'
        ? status.downloadPercent
        : null,
    hasUpdate: Boolean(status.hasUpdate),
    downloaded: Boolean(status.downloaded),
    busy: menuCheckRunning,
    onCheckForUpdates: () => {
      void checkForUpdatesFromMenu();
    },
    onShowTillAddress: isAdminShell()
      ? undefined
      : () => {
          void showTillAddressFromMenu();
        },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function setupAppMenu(): void {
  if (menuInstalled) {
    refreshAppMenu();
    return;
  }
  menuInstalled = true;
  onUpdaterStatusChange(() => refreshAppMenu());
  refreshAppMenu();
}
