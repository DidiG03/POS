import { describe, expect, it, beforeEach } from 'vitest';
import {
  allowRateLimit,
  canIssueLicense,
  clientIpFromHeaders,
  mapSubStatus,
  resetRateLimitsForTests,
  shouldUpdatePaymentInsteadOfCheckout,
} from './billingGuards';

describe('mapSubStatus', () => {
  it('treats active and trialing as ACTIVE', () => {
    expect(mapSubStatus('active')).toBe('ACTIVE');
    expect(mapSubStatus('trialing')).toBe('ACTIVE');
    expect(mapSubStatus('TRIALING')).toBe('ACTIVE');
  });

  it('maps failed invoices to PAST_DUE', () => {
    expect(mapSubStatus('past_due')).toBe('PAST_DUE');
    expect(mapSubStatus('unpaid')).toBe('PAST_DUE');
    expect(mapSubStatus('incomplete')).toBe('PAST_DUE');
  });

  it('maps canceled and unknown to PAUSED', () => {
    expect(mapSubStatus('canceled')).toBe('PAUSED');
    expect(mapSubStatus('incomplete_expired')).toBe('PAUSED');
    expect(mapSubStatus('')).toBe('PAUSED');
  });
});

describe('license issue vs checkout', () => {
  it('only issues a key while ACTIVE', () => {
    expect(canIssueLicense('ACTIVE')).toBe(true);
    expect(canIssueLicense('PAST_DUE')).toBe(false);
    expect(canIssueLicense('PAUSED')).toBe(false);
  });

  it('sends past_due customers to the portal instead of a new Checkout', () => {
    expect(shouldUpdatePaymentInsteadOfCheckout('PAST_DUE')).toBe(true);
    expect(shouldUpdatePaymentInsteadOfCheckout('ACTIVE')).toBe(false);
    expect(shouldUpdatePaymentInsteadOfCheckout('PAUSED')).toBe(false);
  });
});

describe('clientIpFromHeaders', () => {
  it('prefers x-real-ip over a spoofed X-Forwarded-For', () => {
    expect(
      clientIpFromHeaders({
        'x-forwarded-for': '1.1.1.1, 10.0.0.1',
        'x-real-ip': '203.0.113.9',
      }),
    ).toBe('203.0.113.9');
  });

  it('uses the last X-Forwarded-For hop when platform headers are missing', () => {
    expect(
      clientIpFromHeaders({
        'x-forwarded-for': '1.1.1.1, 10.0.0.1, 198.51.100.20',
      }),
    ).toBe('198.51.100.20');
  });

  it('falls back to the socket address', () => {
    expect(clientIpFromHeaders({}, '::1')).toBe('::1');
    expect(clientIpFromHeaders({}, null)).toBe('unknown');
  });
});

describe('allowRateLimit', () => {
  beforeEach(() => resetRateLimitsForTests());

  it('allows up to max hits inside the window', () => {
    expect(allowRateLimit('ip:a', 2, 60_000, 1_000)).toBe(true);
    expect(allowRateLimit('ip:a', 2, 60_000, 1_001)).toBe(true);
    expect(allowRateLimit('ip:a', 2, 60_000, 1_002)).toBe(false);
  });

  it('resets after the window', () => {
    expect(allowRateLimit('ip:b', 1, 100, 1_000)).toBe(true);
    expect(allowRateLimit('ip:b', 1, 100, 1_050)).toBe(false);
    expect(allowRateLimit('ip:b', 1, 100, 1_101)).toBe(true);
  });
});
