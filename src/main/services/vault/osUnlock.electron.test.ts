import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safe } = vi.hoisted(() => ({
  safe: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`)),
    decryptString: vi.fn((blob: Buffer) =>
      blob.toString().replace(/^enc:/, ''),
    ),
  },
}));

// The real module, not the test injection: the packaged till reached
// safeStorage through createRequire, got nothing back, and every till then
// asked for its passphrase on each start.
vi.mock('electron', () => ({ safeStorage: safe }));

import {
  isOsUnlockAvailable,
  setOsVaultCryptoForTests,
  unwrapDekFromOs,
  wrapDekForOs,
} from './osUnlock';

describe('OS unlock through Electron safeStorage', () => {
  beforeEach(() => setOsVaultCryptoForTests(null));

  it('uses the electron module the main process imports', () => {
    expect(isOsUnlockAvailable()).toBe(true);
  });

  it('wraps and unwraps the till key', () => {
    const dek = Buffer.alloc(32, 7);
    const blob = wrapDekForOs(dek);
    expect(blob).toBeTruthy();
    expect(unwrapDekFromOs(blob!)).toEqual(dek);
  });

  it('reports unavailable when the OS store is', () => {
    safe.isEncryptionAvailable.mockReturnValueOnce(false);
    expect(isOsUnlockAvailable()).toBe(false);
  });
});
