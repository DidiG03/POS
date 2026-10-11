/**
 * VAT on tickets/receipts follows fiscalization (Fiskalizimi), not a
 * separate preference — except for a seller outside the VAT scheme, whose
 * invoices are filed at band A and whose receipts must not show VAT.
 */
export function isVatEnabledFromSettings(settings: unknown): boolean {
  const fiscal = (
    settings as {
      fiscal?: { enabled?: boolean; vat?: { nonVatBusiness?: boolean } };
    } | null
  )?.fiscal;
  return Boolean(fiscal?.enabled) && fiscal?.vat?.nonVatBusiness !== true;
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
