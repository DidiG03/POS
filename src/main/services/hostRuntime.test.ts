import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: () => undefined,
    quit: () => undefined,
    dock: { show: () => undefined },
    setLoginItemSettings: () => undefined,
    getLoginItemSettings: () => ({ wasOpenedAsHidden: false }),
    getFileIcon: async () => ({ isEmpty: () => true, resize: () => ({}) }),
  },
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
    createEmpty: () => ({}),
  },
  BrowserWindow: class {},
  dialog: { showMessageBox: async () => ({ response: 0 }) },
}));

import {
  HOST_HIDDEN_LAUNCH_ARG,
  argvRequestsHiddenLaunch,
  isOpenAtLoginEnabled,
  resolveBackgroundHostEnabled,
  shouldStartHidden,
} from './hostRuntime';

describe('hostRuntime helpers', () => {
  it('keeps auto-start on when the setting is missing (existing venues)', () => {
    expect(isOpenAtLoginEnabled(undefined)).toBe(true);
    expect(isOpenAtLoginEnabled({})).toBe(true);
    expect(isOpenAtLoginEnabled({ host: {} })).toBe(true);
  });

  it('honours an explicit off switch', () => {
    expect(isOpenAtLoginEnabled({ host: { openAtLogin: false } })).toBe(false);
    expect(isOpenAtLoginEnabled({ host: { openAtLogin: true } })).toBe(true);
  });

  it('detects a hidden login-item launch from argv', () => {
    expect(argvRequestsHiddenLaunch(['electron', '.'])).toBe(false);
    expect(
      argvRequestsHiddenLaunch(['electron', '.', HOST_HIDDEN_LAUNCH_ARG]),
    ).toBe(true);
  });

  it('starts hidden from argv or the OS hidden-launch flag', () => {
    expect(shouldStartHidden(['electron'], false)).toBe(false);
    expect(shouldStartHidden(['electron', '--hidden'], false)).toBe(true);
    expect(shouldStartHidden(['electron'], true)).toBe(true);
  });

  it('enables the background host in packaged builds, with env overrides', () => {
    expect(resolveBackgroundHostEnabled({ env: {}, isPackaged: true })).toBe(
      true,
    );
    expect(resolveBackgroundHostEnabled({ env: {}, isPackaged: false })).toBe(
      false,
    );
    expect(
      resolveBackgroundHostEnabled({
        env: { POS_HOST_BACKGROUND: '1' },
        isPackaged: false,
      }),
    ).toBe(true);
    expect(
      resolveBackgroundHostEnabled({
        env: { POS_HOST_BACKGROUND: '0' },
        isPackaged: true,
      }),
    ).toBe(false);
  });
});
