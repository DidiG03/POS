import { describe, expect, it } from 'vitest';
import {
  dekToEncryptionKey,
  generateDek,
  generateRecoveryKey,
  normalizeRecoveryKey,
  recoveryKeyToBytes,
  unwrapKey,
  wrapKey,
} from './crypto';

const FAST = { t: 1, m: 16, p: 1 };

describe('wrapKey / unwrapKey', () => {
  it('round-trips a DEK and rejects the wrong secret', async () => {
    const dek = generateDek();
    const wrapped = await wrapKey('recovery-secret-1', dek, FAST);
    const ok = await unwrapKey('recovery-secret-1', wrapped);
    expect(ok?.equals(dek)).toBe(true);
    expect(await unwrapKey('wrong-secret', wrapped)).toBeNull();
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
