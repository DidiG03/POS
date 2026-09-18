import type { MenuItemConstructorOptions } from 'electron';

export type AppMenuPlatform = 'darwin' | 'win32' | 'linux';

export type AppMenuTemplateOpts = {
  platform: AppMenuPlatform;
  appName: string;
  version: string;
  checking: boolean;
  downloading: boolean;
  downloadPercent: number | null;
  hasUpdate: boolean;
  downloaded: boolean;
  busy?: boolean;
  onCheckForUpdates: () => void;
  onShowTillAddress?: () => void;
};

export function updateMenuLabel(opts: {
  checking: boolean;
  downloading: boolean;
  downloadPercent: number | null;
  hasUpdate: boolean;
  downloaded: boolean;
}): string {
  if (opts.downloaded) return 'Install Update and Restart';
  if (opts.downloading) {
    const pct =
      typeof opts.downloadPercent === 'number' ? opts.downloadPercent : 0;
    return `Downloading Update (${pct}%)`;
  }
  if (opts.checking) return 'Checking for Updates…';
  if (opts.hasUpdate) return 'Download and Install Update…';
  return 'Check for Updates…';
}

export function buildAppMenuTemplate(
  opts: AppMenuTemplateOpts,
): MenuItemConstructorOptions[] {
  const updateItem = (): MenuItemConstructorOptions => ({
    label: updateMenuLabel(opts),
    enabled: !opts.checking && !opts.downloading && !opts.busy,
    click: () => opts.onCheckForUpdates(),
  });

  const tillAddressItem = (): MenuItemConstructorOptions | null =>
    opts.onShowTillAddress
      ? {
          label: 'This Till’s Address…',
          click: () => opts.onShowTillAddress?.(),
        }
      : null;

  const template: MenuItemConstructorOptions[] = [];

  if (opts.platform === 'darwin') {
    template.push({
      label: opts.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        updateItem(),
        ...(tillAddressItem() ? [tillAddressItem()!] : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      ...(opts.platform === 'darwin'
        ? []
        : [
            updateItem(),
            ...(tillAddressItem() ? [tillAddressItem()!] : []),
            { type: 'separator' as const },
          ]),
      opts.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  });

  template.push({ role: 'editMenu' });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({ role: 'windowMenu' });

  template.push({
    role: 'help',
    submenu: [
      updateItem(),
      ...(tillAddressItem() ? [tillAddressItem()!] : []),
      { type: 'separator' },
      {
        label: `Version ${opts.version}`,
        enabled: false,
      },
    ],
  });

  return template;
}
