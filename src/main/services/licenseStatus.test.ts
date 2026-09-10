import { describe, expect, it } from 'vitest';
import {
  licenseStatusForRenderer,
  parseStoredLicenseStatus,
} from './licenseStatus';

describe('parseStoredLicenseStatus', () => {
  it('accepts known statuses', () => {
    expect(parseStoredLicenseStatus('ACTIVE')).toBe('ACTIVE');
    expect(parseStoredLicenseStatus('past_due')).toBe('PAST_DUE');
    expect(parseStoredLicenseStatus('PAUSED')).toBe('PAUSED');
  });

  it('does not treat a missing status as ACTIVE', () => {
    expect(parseStoredLicenseStatus(undefined)).toBe('PAUSED');
    expect(parseStoredLicenseStatus('')).toBe('PAUSED');
    expect(parseStoredLicenseStatus('nope')).toBe('PAUSED');
  });
});

describe('licenseStatusForRenderer', () => {
  const st = {
    required: true,
    licensed: true,
    billingConfigured: true,
    key: 'POS1.secret.key',
    email: 'a@b.com',
    status: 'ACTIVE' as const,
  };

  it('keeps the key for an admin session', () => {
    expect(licenseStatusForRenderer(st, true).key).toBe('POS1.secret.key');
  });

  it('strips the key for everyone else', () => {
    expect(licenseStatusForRenderer(st, false).key).toBeUndefined();
    expect(licenseStatusForRenderer(st, false).email).toBe('a@b.com');
  });
});
