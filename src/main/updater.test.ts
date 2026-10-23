/**
 * The periodic update check must not forget an update that is already
 * downloaded and waiting to install.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updater } = vi.hoisted(() => ({ updater: { current: null as any } }));

vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const u: any = new Emitter();
  u.checkForUpdates = vi.fn(async () => undefined);
  u.downloadUpdate = vi.fn(async () => {
    u.emit('update-downloaded', { version: u.announced });
  });
  u.setFeedURL = vi.fn();
  updater.current = u;
  return { autoUpdater: u };
});
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.2.91',
    getName: () => 'OneTap POS',
  },
  BrowserWindow: class {},
}));
vi.mock('./services/sentry', () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('./services/hostRuntime', () => ({ allowNextQuit: vi.fn() }));
vi.mock('./services/macBundleUpdate', () => ({
  canReplaceMacBundle: () => true,
  launchMacBundleSwap: vi.fn(),
  macBundlePathFromExec: () => null,
  pendingUpdateZip: () => null,
  readMacSignatureKind: () => 'developer-id',
  updaterCacheDirNameFromYml: () => null,
}));

import { setupAutoUpdater, updaterHandlers } from './updater';

describe('updater re-check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('keeps a downloaded update ready across the periodic check', async () => {
    setupAutoUpdater({ autoDownload: true });
    const u: EventEmitter & Record<string, any> = updater.current;

    u.announced = '0.2.92';
    u.emit('update-available', { version: '0.2.92' });
    await vi.waitFor(() =>
      expect(updaterHandlers.getUpdateStatus().downloaded).toBe(true),
    );
    expect(u.downloadUpdate).toHaveBeenCalledTimes(1);

    // Four hours later the feed announces the same release again.
    u.emit('update-available', { version: '0.2.92' });
    expect(updaterHandlers.getUpdateStatus().downloaded).toBe(true);
    expect(u.downloadUpdate).toHaveBeenCalledTimes(1);

    // A newer release replaces it and is fetched.
    u.announced = '0.2.93';
    u.emit('update-available', { version: '0.2.93' });
    await vi.waitFor(() => expect(u.downloadUpdate).toHaveBeenCalledTimes(2));
    expect(updaterHandlers.getUpdateStatus().updateInfo?.version).toBe(
      '0.2.93',
    );
    vi.useRealTimers();
  });
});
