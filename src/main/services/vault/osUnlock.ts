/**
 * Wrap the till DEK with the logged-in OS user (DPAPI / Keychain).
 *
 * This is what lets OneTap open after Windows or macOS has already unlocked.
 * It is not a substitute for BitLocker/FileVault
 * against a thief who can boot the stolen PC as the same user.
 */

import * as electron from 'electron';
import { dekToEncryptionKey } from './crypto';

export type OsVaultCrypto = {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(blob: string): string | null;
};

let injected: OsVaultCrypto | null = null;

export function setOsVaultCryptoForTests(crypto: OsVaultCrypto | null): void {
  injected = crypto;
}

type SafeStorageLike = {
  isEncryptionAvailable?: () => boolean;
  encryptString?: (plain: string) => Buffer;
  decryptString?: (blob: Buffer) => string;
};

/**
 * Electron's `safeStorage`, through the same ESM import the rest of the main
 * process uses. It used to come from `createRequire(import.meta.url)`, which
 * in the packaged app did not hand back Electron's module: every till then
 * reported "cannot store the till key", kept asking for the passphrase on
 * each start, and a fresh till could not be encrypted at all. Tests inject a
 * fake instead, which is why they never saw it.
 */
function electronSafeStorage(): SafeStorageLike | undefined {
  const mod = electron as unknown as {
    safeStorage?: SafeStorageLike;
    default?: { safeStorage?: SafeStorageLike };
  };
  return mod?.safeStorage ?? mod?.default?.safeStorage;
}

function electronCrypto(): OsVaultCrypto | null {
  try {
    const safe = electronSafeStorage();
    if (
      !safe?.isEncryptionAvailable ||
      !safe.encryptString ||
      !safe.decryptString
    ) {
      return null;
    }
    return {
      isAvailable: () => Boolean(safe.isEncryptionAvailable?.()),
      encrypt: (plain) => safe.encryptString!(plain).toString('base64'),
      decrypt: (blob) => {
        try {
          return safe.decryptString!(Buffer.from(blob, 'base64'));
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}

function backend(): OsVaultCrypto | null {
  return injected || electronCrypto();
}

export function isOsUnlockAvailable(): boolean {
  try {
    return Boolean(backend()?.isAvailable());
  } catch {
    return false;
  }
}

export function wrapDekForOs(dek: Buffer): string | null {
  const crypto = backend();
  if (!crypto?.isAvailable()) return null;
  try {
    return crypto.encrypt(dekToEncryptionKey(dek));
  } catch {
    return null;
  }
}

export function unwrapDekFromOs(blob: string): Buffer | null {
  const crypto = backend();
  if (!crypto?.isAvailable()) return null;
  try {
    const hex = crypto.decrypt(blob);
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    return Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
}
