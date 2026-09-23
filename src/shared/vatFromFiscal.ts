/** VAT on tickets/receipts follows fiscalization (Fiskalizimi), not a separate preference. */
export function isVatEnabledFromSettings(settings: unknown): boolean {
  return Boolean(
    (settings as { fiscal?: { enabled?: boolean } } | null)?.fiscal?.enabled,
  );
}

/**
 * Resolve whether VAT applies for a payment/receipt.
 * Fiskalizimi is the only switch — stored meta.vatEnabled is ignored so
 * turning fiscal off turns VAT off everywhere (and on turns it on).
 */
export function resolveVatEnabledFromMeta(
  _meta: { vatEnabled?: boolean | null } | null | undefined,
  settings: unknown,
): boolean {
  return isVatEnabledFromSettings(settings);
}
