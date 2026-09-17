import { useLicenseCapabilities } from '../stores/licenseCapabilities';

/** Apply the till's paid plan from a successful settings payload.
 *  A failed fetch must not call this — restaurant defaults would stick. */
export function hydrateLicenseEditionFromSettings(
  settings: { licenseEdition?: unknown } | null | undefined,
): void {
  if (!settings || typeof settings !== 'object') return;
  useLicenseCapabilities
    .getState()
    .setEdition(
      settings.licenseEdition == null
        ? undefined
        : String(settings.licenseEdition),
    );
}
