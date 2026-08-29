import { describe, expect, it } from 'vitest';
import {
  issueLicenseKey,
  normalizeLicenseEmail,
  parseLicenseKey,
} from './licenseKey';

describe('licenseKey', () => {
  const secret = 'test-secret-test-secret-test-secret';

  it('round-trips customer id and email', () => {
    const key = issueLicenseKey('cus_123', 'Owner@Venue.com', secret);
    const parsed = parseLicenseKey(key, secret);
    expect(parsed).toEqual({ v: 1, cid: 'cus_123', em: 'owner@venue.com' });
  });

  it('normalizes email case', () => {
    expect(normalizeLicenseEmail('  A@B.COM ')).toBe('a@b.com');
  });

  it('rejects a tampered key', () => {
    const key = issueLicenseKey('cus_123', 'a@b.com', secret);
    const parts = key.split('.');
    const flipped =
      parts[1].slice(0, -1) + (parts[1].endsWith('A') ? 'B' : 'A');
    expect(
      parseLicenseKey([parts[0], flipped, parts[2]].join('.'), secret),
    ).toBeNull();
    expect(parseLicenseKey(key, 'other-secret-other-secret-other')).toBeNull();
    expect(parseLicenseKey('POS1.abc.def', secret)).toBeNull();
  });

  it('is deterministic for restore', () => {
    const a = issueLicenseKey('cus_1', 'x@y.z', secret);
    const b = issueLicenseKey('cus_1', 'X@Y.Z', secret);
    expect(a).toBe(b);
  });
});
