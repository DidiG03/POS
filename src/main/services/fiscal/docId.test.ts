/**
 * docId rules.
 *
 * A docId that changes between attempts makes the status check useless: it
 * asks about a document the provider has never seen, gets "not found", and
 * the replay files a second invoice. So the interesting cases are the ones
 * where a value could silently change or be rejected.
 */

import { describe, expect, it } from 'vitest';
import {
  assertDistinctCancellationDocId,
  assertValidDocId,
  docIdFromKey,
  newDocId,
  validateDocId,
} from './docId';

describe('validateDocId', () => {
  it('enforces the API 5–200 character range', () => {
    expect(validateDocId('abcde').ok).toBe(true);
    expect(validateDocId('a'.repeat(200)).ok).toBe(true);
    expect(validateDocId('abcd').ok).toBe(false);
    expect(validateDocId('a'.repeat(201)).ok).toBe(false);
  });

  it('names the actual length so the message is actionable', () => {
    expect(validateDocId('ab').error).toMatch(
      /at least 5 characters \(got 2\)/,
    );
    expect(validateDocId('a'.repeat(250)).error).toMatch(
      /at most 200 characters \(got 250\)/,
    );
  });

  it('rejects blank and whitespace', () => {
    expect(validateDocId('').ok).toBe(false);
    expect(validateDocId('     ').ok).toBe(false);
    expect(validateDocId(null).ok).toBe(false);
    expect(validateDocId(undefined).ok).toBe(false);
  });

  it('trims before measuring', () => {
    const check = validateDocId('  abcdef  ');
    expect(check.ok).toBe(true);
    expect(check.docId).toBe('abcdef');
  });
});

describe('newDocId', () => {
  it('produces a valid docId for each purpose', () => {
    for (const purpose of ['invoice', 'cancellation', 'balance'] as const) {
      const id = newDocId(purpose);
      expect(validateDocId(id).ok).toBe(true);
      expect(() => assertValidDocId(id)).not.toThrow();
    }
  });

  it('is traceable back to the kind of document', () => {
    expect(newDocId('invoice')).toMatch(/^inv-/);
    expect(newDocId('cancellation')).toMatch(/^cnl-/);
    expect(newDocId('balance')).toMatch(/^bal-/);
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newDocId('invoice')));
    expect(ids.size).toBe(500);
  });
});

describe('docIdFromKey', () => {
  it('passes a usable key straight through', () => {
    // The key is what the rest of the POS stores and searches by, so
    // rewriting it would make a docId in an easyPos log untraceable here.
    const key = '6f9d0d1e-4c2b-4e5a-9f11-2b0f7a1c8e33';
    expect(docIdFromKey(key)).toBe(key);
  });

  it('pads a too-short key deterministically', () => {
    // Deterministic matters: a random pad would produce a different docId
    // on retry, which is the whole failure this module exists to prevent.
    expect(docIdFromKey('ab')).toBe(docIdFromKey('ab'));
    expect(validateDocId(docIdFromKey('ab')).ok).toBe(true);
  });

  it('refuses to truncate a too-long key', () => {
    // Truncating would risk two different sales colliding on one docId.
    expect(() => docIdFromKey('x'.repeat(201))).toThrow(/201 characters/);
  });

  it('mints one when there is no key at all', () => {
    expect(validateDocId(docIdFromKey('')).ok).toBe(true);
  });
});

describe('assertDistinctCancellationDocId', () => {
  it('accepts a genuinely new docId', () => {
    expect(
      assertDistinctCancellationDocId({
        cancellationDocId: 'cnl-1234567',
        originalDocId: 'inv-7654321',
      }),
    ).toBe('cnl-1234567');
  });

  it('refuses the cancelled invoice own docId', () => {
    // A cancellation is its own business document. Filing it under the
    // original docId makes the two indistinguishable in recovery.
    expect(() =>
      assertDistinctCancellationDocId({
        cancellationDocId: 'inv-7654321',
        originalDocId: 'inv-7654321',
      }),
    ).toThrow(/must use a new docId/);
  });

  it('still enforces the length rule', () => {
    expect(() =>
      assertDistinctCancellationDocId({ cancellationDocId: 'ab' }),
    ).toThrow(/at least 5/);
  });
});
