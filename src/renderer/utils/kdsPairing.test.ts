/** QA v0.2.104 #13: the page's copy of the pairing may be lost; the app's is not. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KDS_DEVICE_TOKEN_KEY,
  clearKdsDeviceToken,
  readKdsDeviceToken,
  writeKdsDeviceToken,
} from './kdsPairing';

const local = new Map<string, string>();
const disk = { token: null as string | null };

beforeEach(() => {
  local.clear();
  disk.token = null;
  (globalThis as any).localStorage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  };
  (globalThis as any).window = {
    kdsApp: {
      getDeviceTokenSync: () => disk.token,
      saveDeviceToken: vi.fn(async (t: string | null) => {
        disk.token = t;
        return true;
      }),
    },
  };
});

describe('KDS pairing token', () => {
  it('is kept by the app as well as the page', () => {
    writeKdsDeviceToken('tok-1234567890');
    expect(local.get(KDS_DEVICE_TOKEN_KEY)).toBe('tok-1234567890');
    expect(disk.token).toBe('tok-1234567890');
  });

  it('after an update lost the page copy, the app copy pairs it again', () => {
    disk.token = 'tok-1234567890';
    expect(readKdsDeviceToken()).toBe('tok-1234567890');
    // And the page copy is restored.
    expect(local.get(KDS_DEVICE_TOKEN_KEY)).toBe('tok-1234567890');
  });

  it('un-pairing clears both', () => {
    writeKdsDeviceToken('tok-1234567890');
    clearKdsDeviceToken();
    expect(readKdsDeviceToken()).toBeNull();
    expect(disk.token).toBeNull();
  });

  it('outside the KDS app (a browser) it is the page copy only', () => {
    (globalThis as any).window = {};
    writeKdsDeviceToken('tok-1234567890');
    expect(readKdsDeviceToken()).toBe('tok-1234567890');
  });
});
