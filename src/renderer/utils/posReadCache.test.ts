import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { invalidateCache } from './swrCache';
import {
  installPosReadCache,
  POS_CACHE,
  resetPosReadCacheForTests,
} from './posReadCache';

describe('installPosReadCache', () => {
  const prevWindow = (globalThis as any).window;

  beforeEach(() => {
    resetPosReadCacheForTests();
    invalidateCache(POS_CACHE.settings);
    (globalThis as any).window = {};
  });

  afterEach(() => {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  });

  it('does not throw when Electron freezes window.api', () => {
    const get = async () => ({ theme: 'dark' });
    const settings = Object.freeze({ get });
    const api = Object.freeze({ settings });
    (window as any).api = api;
    expect(() => installPosReadCache()).not.toThrow();
    expect((window as any).api.settings.get).toBe(get);
  });

  it('wraps writable browser polyfill methods', async () => {
    let calls = 0;
    const api = {
      settings: {
        get: async () => {
          calls += 1;
          return { theme: 'dark' };
        },
      },
    };
    (window as any).api = api;
    installPosReadCache();
    const a = await (window as any).api.settings.get();
    const b = await (window as any).api.settings.get();
    expect(a).toEqual({ theme: 'dark' });
    expect(b).toEqual({ theme: 'dark' });
    expect(calls).toBe(1);
  });
});
