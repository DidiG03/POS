import {
  parseLicenseEdition,
  type LicenseEdition,
} from './licenseKey.js';

/**
 * Prefer the HMAC-signed key edition over Stripe's restaurant fallback.
 * Only reject when Stripe has an explicit plan (metadata or known price id)
 * that disagrees with the key.
 */
export function resolveValidatedLicenseEdition(input: {
  keyEdition?: string | null;
  stripeEdition?: string | null;
}): { edition: LicenseEdition; mismatch: boolean } {
  const key = parseLicenseEdition(input.keyEdition);
  const stripe = parseLicenseEdition(input.stripeEdition);
  if (key && stripe && key !== stripe) {
    return { edition: key, mismatch: true };
  }
  if (key) return { edition: key, mismatch: false };
  if (stripe) return { edition: stripe, mismatch: false };
  return { edition: 'RESTAURANT', mismatch: false };
}
