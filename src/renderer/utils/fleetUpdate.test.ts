import { afterEach, describe, expect, it } from 'vitest';
import { TILL_ONLY } from '@shared/tillOnly';
import {
  installFleetUpdates,
  isStatusBusy,
  summarizeFleetStatus,
  waitWhileBusy,
} from './fleetUpdate';
import type { UpdateStatusDTO } from '@shared/ipc';

function status(overrides: Partial<UpdateStatusDTO> = {}): UpdateStatusDTO {
  return {
    hasUpdate: false,
    updateInfo: null,
    downloaded: false,
    checking: false,
    currentVersion: '0.2.40',
    ...overrides,
  };
}

describe('isStatusBusy', () => {
  it('treats a missing till as idle so Admin does not wait forever', () => {
    expect(isStatusBusy(null)).toBe(false);
    expect(isStatusBusy(status({ checking: true }))).toBe(true);
    expect(isStatusBusy(status({ downloading: true }))).toBe(true);
  });
});

describe('waitWhileBusy', () => {
  it('returns when the till finishes checking', async () => {
    let n = 0;
    const last = await waitWhileBusy(
      async () => {
        n += 1;
        return status({ checking: n < 3 });
      },
      { intervalMs: 1, timeoutMs: 1000 },
    );
    expect(last?.checking).toBe(false);
    expect(n).toBe(3);
  });
});

describe('summarizeFleetStatus', () => {
  it('explains a missing POS when Admin is on another computer', () => {
    const summary = summarizeFleetStatus({
      admin: status(),
      pos: null,
    });
    expect(summary.posUnreachable).toBe(true);
    expect(summary.detail).toMatch(/POS till cannot be reached/i);
    expect(summary.detail).toMatch(/Admin app/i);
  });

  it('offers install when the till already downloaded a package', () => {
    const summary = summarizeFleetStatus({
      admin: status(),
      pos: status({
        hasUpdate: true,
        downloaded: true,
        updateInfo: {
          version: '0.2.41',
          releaseDate: null,
          releaseNotes: '',
        },
      }),
    });
    expect(summary.readyToInstall).toBe(true);
    expect(summary.title).toMatch(/ready to install/i);
    expect(summary.detail).toMatch(/0\.2\.41/);
  });
});

describe('installFleetUpdates', () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  function setApi(opts: { posPending: boolean; refuse: boolean }) {
    const calls: string[] = [];
    (globalThis as any).window = {
      api: {
        hostUpdates: {
          install: async () => {
            calls.push('pos');
            if (opts.refuse) {
              throw Object.assign(new Error('till only'), { code: TILL_ONLY });
            }
            return { success: true };
          },
          getStatus: async () =>
            status({ hasUpdate: opts.posPending, downloaded: opts.posPending }),
        },
        updater: {
          getUpdateStatus: async () => status({ downloaded: true }),
          installUpdate: async () => {
            calls.push('admin');
            return { success: true };
          },
        },
      },
    };
    return calls;
  }

  it('leaves Admin alone while a remote till still has its update waiting', async () => {
    const calls = setApi({ posPending: true, refuse: true });
    const r = await installFleetUpdates();
    expect(r.tillOnly).toBe(true);
    expect(calls).toEqual(['pos']);
  });

  it('updates Admin once the remote till is up to date', async () => {
    const calls = setApi({ posPending: false, refuse: true });
    const r = await installFleetUpdates();
    expect(r).toEqual({});
    expect(calls).toEqual(['pos', 'admin']);
  });

  it('installs both when the till accepts', async () => {
    const calls = setApi({ posPending: true, refuse: false });
    const r = await installFleetUpdates();
    expect(r).toEqual({});
    expect(calls).toEqual(['pos', 'admin']);
  });
});
