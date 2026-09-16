import { describe, expect, it } from 'vitest';
import {
  dekToEncryptionKey,
  generateDek,
  generateRecoveryKey,
  normalizeRecoveryKey,
  recoveryKeyToBytes,
  unwrapKey,
  validatePassphrase,
  wrapKey,
} from './crypto';

const FAST = { t: 1, m: 16, p: 1 };

describe('validatePassphrase', () => {
  it('rejects short, long, and digit-only secrets', () => {
    expect(validatePassphrase('short')).toEqual({
      ok: false,
      error: 'too_short',
    });
    expect(validatePassphrase('123456789012')).toEqual({
      ok: false,
      error: 'digits_only',
    });
    expect(validatePassphrase('a'.repeat(201)).ok).toBe(false);
    expect(validatePassphrase('kitchen-pass-1').ok).toBe(true);
  });
});

describe('wrapKey / unwrapKey', () => {
  it('round-trips a DEK and rejects the wrong secret', async () => {
    const dek = generateDek();
    const wrapped = await wrapKey('kitchen-pass-1', dek, FAST);
    const ok = await unwrapKey('kitchen-pass-1', wrapped);
    expect(ok?.equals(dek)).toBe(true);
    expect(await unwrapKey('wrong-pass-phrase', wrapped)).toBeNull();
  });
});

describe('recovery key', () => {
  it('normalizes grouped hex back to 16 bytes', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
    const bytes = recoveryKeyToBytes(key.toLowerCase().replace(/-/g, ' '));
    expect(bytes?.length).toBe(16);
    expect(normalizeRecoveryKey(key)).toHaveLength(32);
  });

  it('wraps the DEK with the recovery key bytes', async () => {
    const dek = generateDek();
    const recovery = generateRecoveryKey();
    const bytes = recoveryKeyToBytes(recovery)!;
    const wrapped = await wrapKey(bytes, dek, FAST);
    expect((await unwrapKey(bytes, wrapped))?.equals(dek)).toBe(true);
    expect(dekToEncryptionKey(dek)).toHaveLength(64);
  });
});
