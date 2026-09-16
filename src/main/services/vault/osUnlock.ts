/**
 * Wrap the till DEK with the logged-in OS user (DPAPI / Keychain).
 *
 * This is what lets OneTap open without typing a passphrase after Windows or
 * macOS has already unlocked. It is not a substitute for BitLocker/FileVault
 * against a thief who can boot the stolen PC as the same user.
 */

import { createRequire } from 'node:module';
import { dekToEncryptionKey } from './crypto';

export type OsVaultCrypto = {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(blob: string): string | null;
};

const requireFromHere = createRequire(import.meta.url);

let injected: OsVaultCrypto | null = null;

export function setOsVaultCryptoForTests(crypto: OsVaultCrypto | null): void {
  injected = crypto;
}

function electronCrypto(): OsVaultCrypto | null {
  try {
    const electron = requireFromHere('electron') as {
      safeStorage?: {
        isEncryptionAvailable?: () => boolean;
        encryptString?: (plain: string) => Buffer;
        decryptString?: (blob: Buffer) => string;
      };
    };
    const safe = electron?.safeStorage;
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
