import { describe, expect, it, vi } from 'vitest';
import { applyRemoteAppUpdate } from './remoteAppUpdate';

describe('applyRemoteAppUpdate', () => {
  it('checks when Admin asks kitchen displays to look for a version', async () => {
    const updater = {
      checkForUpdates: vi.fn().mockResolvedValue({ success: true }),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      getUpdateStatus: vi.fn(),
    };
    await applyRemoteAppUpdate('check', updater);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.installUpdate).not.toHaveBeenCalled();
  });

  it('downloads only when a KDS update is already known', async () => {
    const updater = {
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn().mockResolvedValue({ success: true }),
      installUpdate: vi.fn(),
      getUpdateStatus: vi.fn().mockResolvedValue({ hasUpdate: true }),
    };
    await applyRemoteAppUpdate('download', updater);
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  });

  it('installs a downloaded KDS update, otherwise starts a check', async () => {
    const ready = {
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn().mockResolvedValue({ success: true }),
      getUpdateStatus: vi.fn().mockResolvedValue({ downloaded: true }),
    };
    await applyRemoteAppUpdate('install', ready);
    expect(ready.installUpdate).toHaveBeenCalledOnce();

    const pending = {
      checkForUpdates: vi.fn().mockResolvedValue({ success: true }),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      getUpdateStatus: vi.fn().mockResolvedValue({ downloaded: false }),
    };
    await applyRemoteAppUpdate('install', pending);
    expect(pending.checkForUpdates).toHaveBeenCalledOnce();
    expect(pending.installUpdate).not.toHaveBeenCalled();
  });
});
