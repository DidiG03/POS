/**
 * Always-on POS host: keep the LAN API alive when the till window is closed.
 *
 * Tablets talk to the HTTP server this process owns, not to the Electron
 * window. Closing the UI used to quit the app (and kill every iPad). This
 * module hides the window to a tray icon instead, starts at login, and
 * refuses a second instance so two hosts don't fight over port 3333.
 */
import {
  app,
  Tray,
  Menu,
  nativeImage,
  BrowserWindow,
  dialog,
  type NativeImage,
} from 'electron';

export const HOST_HIDDEN_LAUNCH_ARG = '--hidden';

type HostSettings = { host?: { openAtLogin?: boolean } } | null | undefined;

type HostRuntimeOpts = {
  getMainWindow: () => BrowserWindow | null;
  createMainWindow: () => void;
  getIconPath: () => string | undefined;
};

let opts: HostRuntimeOpts | null = null;
let tray: Tray | null = null;
let quitConfirmed = false;
let quitPromptOpen = false;
let pendingShow = false;
let didNotifyHidden = false;

export function resolveBackgroundHostEnabled(input: {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
}): boolean {
  const env = input.env ?? process.env;
  if (env.POS_HOST_BACKGROUND === '0') return false;
  if (env.POS_HOST_BACKGROUND === '1') return true;
  return input.isPackaged;
}

export function isBackgroundHostEnabled(): boolean {
  return resolveBackgroundHostEnabled({
    env: process.env,
    isPackaged: app.isPackaged,
  });
}

export function argvRequestsHiddenLaunch(argv: string[]): boolean {
  return argv.includes(HOST_HIDDEN_LAUNCH_ARG);
}

export function isOpenAtLoginEnabled(settings: HostSettings): boolean {
  return settings?.host?.openAtLogin !== false;
}

export function shouldStartHidden(
  argv: string[] = process.argv,
  wasOpenedAsHidden = false,
): boolean {
  return argvRequestsHiddenLaunch(argv) || wasOpenedAsHidden;
}

export function allowNextQuit(): void {
  quitConfirmed = true;
}

export function isQuitConfirmed(): boolean {
  return quitConfirmed;
}

export function configureHostRuntime(runtime: HostRuntimeOpts): void {
  opts = runtime;
  if (pendingShow) {
    pendingShow = false;
    showMainWindow();
  }
}

export function showMainWindow(): void {
  if (!opts) {
    pendingShow = true;
    return;
  }
  let win = opts.getMainWindow();
  if (!win || win.isDestroyed()) {
    opts.createMainWindow();
    win = opts.getMainWindow();
  }
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') {
    try {
      app.dock?.show();
    } catch {
      // ignore
    }
  }
}

export function applyOpenAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled,
      args: enabled ? [HOST_HIDDEN_LAUNCH_ARG] : [],
    });
  } catch (e) {
    console.warn('[host] setLoginItemSettings failed:', e);
  }
}

function loadTrayImage(iconPath: string | undefined): NativeImage | undefined {
  if (!iconPath) return undefined;
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) return undefined;
    const size = process.platform === 'darwin' ? 18 : 16;
    return img.resize({ width: size, height: size });
  } catch {
    return undefined;
  }
}

function maybeNotifyHidden(): void {
  if (didNotifyHidden || !tray) return;
  didNotifyHidden = true;
  if (process.platform !== 'win32') return;
  try {
    tray.displayBalloon({
      title: 'OneTap POS is still running',
      content:
        'Tablets and iPads stay connected. Click this icon to open the till. Choose Quit to stop.',
    });
  } catch {
    // ignore
  }
}

export function attachMainWindowHideOnClose(win: BrowserWindow): void {
  if (!isBackgroundHostEnabled()) return;
  win.on('close', (event) => {
    if (quitConfirmed) return;
    event.preventDefault();
    win.hide();
    maybeNotifyHidden();
  });
}

export function setupHostTray(): void {
  if (!isBackgroundHostEnabled()) return;
  if (tray) return;
  const image = loadTrayImage(opts?.getIconPath());
  tray = image ? new Tray(image) : new Tray(nativeImage.createEmpty());
  tray.setToolTip('OneTap POS — tablets stay connected');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Tablets stay connected while this icon is here',
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Open POS', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: 'Quit (disconnects tablets)',
        click: () => {
          allowNextQuit();
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showMainWindow());
  if (image) return;
  void app
    .getFileIcon(process.execPath, { size: 'small' })
    .then((icon) => {
      if (!tray || icon.isEmpty()) return;
      const size = process.platform === 'darwin' ? 18 : 16;
      tray.setImage(icon.resize({ width: size, height: size }));
    })
    .catch(() => undefined);
}

export function destroyHostTray(): void {
  try {
    tray?.destroy();
  } catch {
    // ignore
  }
  tray = null;
}

/**
 * Returns false when this process should stop (another instance owns the host).
 */
export function claimSingleInstance(): boolean {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    showMainWindow();
  });
  return true;
}

/**
 * Ask before Cmd+Q so a till isn't taken down accidentally during service.
 * Caller must `event.preventDefault()` synchronously before awaiting this.
 * Tray Quit skips the prompt via `allowNextQuit()`.
 * Returns true when the user confirmed quit.
 */
export async function promptQuitDialog(): Promise<boolean> {
  if (quitConfirmed) return true;
  if (quitPromptOpen) return false;
  quitPromptOpen = true;
  try {
    const win = opts?.getMainWindow();
    const parent =
      win && !win.isDestroyed() && win.isVisible() ? win : undefined;
    const boxOpts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Keep running', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: 'Quit OneTap POS?',
      detail:
        'iPads and tablets will stop working until this app is opened again on this computer.',
    };
    const result = parent
      ? await dialog.showMessageBox(parent, boxOpts)
      : await dialog.showMessageBox(boxOpts);
    return result.response === 1;
  } catch (e) {
    console.warn('[host] quit confirmation failed:', e);
    return true;
  } finally {
    quitPromptOpen = false;
  }
}
