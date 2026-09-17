import type { LicenseEdition } from '@shared/ipc';
import {
  normalizeLicenseEdition,
  peekLicenseEditionFromKey,
} from '@shared/editionCapabilities';

/**
 * Keep a signed STORE key when billing re-issues a restaurant key because
 * Stripe could not classify the subscription (missing metadata / price id).
 */
export function resolveStoredLicenseRecord(input: {
  remoteEdition?: unknown;
  storedEdition?: unknown;
  incomingKey?: string | null;
  previousKey?: string | null;
  presentedKey?: string | null;
}): { key: string; edition?: LicenseEdition } {
  const incomingKey = String(input.incomingKey || '').trim();
  const previousKey = String(input.previousKey || '').trim();
  const presentedKey = String(input.presentedKey || '').trim();
  const incomingEd = peekLicenseEditionFromKey(incomingKey);
  const keepStoreKey =
    peekLicenseEditionFromKey(presentedKey) === 'STORE' ||
    peekLicenseEditionFromKey(previousKey) === 'STORE';
  const key =
    keepStoreKey && incomingEd === 'RESTAURANT'
      ? presentedKey || previousKey || incomingKey
      : incomingKey || previousKey || presentedKey;
  const edition =
    peekLicenseEditionFromKey(key) ||
    normalizeLicenseEdition(input.remoteEdition) ||
    normalizeLicenseEdition(input.storedEdition);
  return { key, edition };
}
