import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  issueLicenseKey,
  normalizeLicenseEmail,
  parseLicenseKey,
} from './licenseKey';

describe('licenseKey', () => {
  const secret = 'test-secret-test-secret-test-secret';

  it('round-trips customer id, email, and edition', () => {
    const key = issueLicenseKey(
      'cus_123',
      'Owner@Venue.com',
      secret,
      'RESTAURANT',
    );
    const parsed = parseLicenseKey(key, secret);
    expect(parsed).toEqual({
      v: 2,
      cid: 'cus_123',
      em: 'owner@venue.com',
      ed: 'RESTAURANT',
    });
  });

  it('is unique per Stripe customer', () => {
    const a = issueLicenseKey('cus_1', 'a@b.com', secret, 'STORE');
    const b = issueLicenseKey('cus_2', 'a@b.com', secret, 'STORE');
    expect(a).not.toBe(b);
  });

  it('issues a different key for restaurant vs store on the same customer', () => {
    const restaurant = issueLicenseKey(
      'cus_1',
      'a@b.com',
      secret,
      'RESTAURANT',
    );
    const store = issueLicenseKey('cus_1', 'a@b.com', secret, 'STORE');
    expect(restaurant).not.toBe(store);
    expect(parseLicenseKey(restaurant, secret)?.ed).toBe('RESTAURANT');
    expect(parseLicenseKey(store, secret)?.ed).toBe('STORE');
  });

  it('normalizes email case', () => {
    expect(normalizeLicenseEmail('  A@B.COM ')).toBe('a@b.com');
  });

  it('rejects a tampered key', () => {
    const key = issueLicenseKey('cus_123', 'a@b.com', secret, 'STORE');
    const parts = key.split('.');
    const flipped =
      parts[1].slice(0, -1) + (parts[1].endsWith('A') ? 'B' : 'A');
    expect(
      parseLicenseKey([parts[0], flipped, parts[2]].join('.'), secret),
    ).toBeNull();
    expect(parseLicenseKey(key, 'other-secret-other-secret-other')).toBeNull();
    expect(parseLicenseKey('POS1.abc.def', secret)).toBeNull();
  });

  it('is deterministic for restore of the same plan', () => {
    const a = issueLicenseKey('cus_1', 'x@y.z', secret, 'STORE');
    const b = issueLicenseKey('cus_1', 'X@Y.Z', secret, 'STORE');
    expect(a).toBe(b);
  });

  it('still parses v1 keys issued before edition', () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, cid: 'cus_old', em: 'old@x.com' }),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const mac = createHmac('sha256', secret)
      .update(payload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const parsed = parseLicenseKey(`POS1.${payload}.${mac}`, secret);
    expect(parsed).toEqual({ v: 1, cid: 'cus_old', em: 'old@x.com' });
  });
});
