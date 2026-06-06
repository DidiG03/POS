/** VAT on tickets/receipts follows fiscalization (Fiskalizimi), not a separate preference. */
export function isVatEnabledFromSettings(settings: unknown): boolean {
  return Boolean(
    (settings as { fiscal?: { enabled?: boolean } } | null)?.fiscal?.enabled,
  );
}

/** Resolve VAT for a stored payment/receipt payload. Explicit meta wins; otherwise fiscal policy. */
export function resolveVatEnabledFromMeta(
  meta: { vatEnabled?: boolean | null } | null | undefined,
  settings: unknown,
): boolean {
  if (meta && typeof meta.vatEnabled === 'boolean') return meta.vatEnabled;
  return isVatEnabledFromSettings(settings);
}
