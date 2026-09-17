import { describe, expect, it } from 'vitest';
import { resolveValidatedLicenseEdition } from './licenseEdition';

describe('resolveValidatedLicenseEdition', () => {
  it('trusts a signed store key when Stripe has no explicit plan', () => {
    expect(
      resolveValidatedLicenseEdition({
        keyEdition: 'STORE',
        stripeEdition: '',
      }),
    ).toEqual({ edition: 'STORE', mismatch: false });
  });

  it('does not overwrite store with the restaurant fallback', () => {
    expect(
      resolveValidatedLicenseEdition({
        keyEdition: 'STORE',
        stripeEdition: undefined,
      }),
    ).toEqual({ edition: 'STORE', mismatch: false });
  });

  it('rejects a store key against an explicit restaurant subscription', () => {
    expect(
      resolveValidatedLicenseEdition({
        keyEdition: 'STORE',
        stripeEdition: 'RESTAURANT',
      }),
    ).toEqual({ edition: 'STORE', mismatch: true });
  });

  it('uses Stripe when the key has no edition (v1)', () => {
    expect(
      resolveValidatedLicenseEdition({
        keyEdition: '',
        stripeEdition: 'STORE',
      }),
    ).toEqual({ edition: 'STORE', mismatch: false });
  });

  it('defaults v1 keys without Stripe edition to restaurant', () => {
    expect(
      resolveValidatedLicenseEdition({
        keyEdition: '',
        stripeEdition: '',
      }),
    ).toEqual({ edition: 'RESTAURANT', mismatch: false });
  });
});
