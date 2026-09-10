/**
 * Payment method mapping for the fiscal payload.
 *
 * Lives here rather than in `vat.ts` / `vatConfig.ts`: a payment type is
 * not a VAT band, and a file named for VAT is where a rate-to-code helper
 * kept being rediscovered after it had been retired.
 */

export function mapPaymentMethod(method: string): string {
  const m = String(method || '')
    .trim()
    .toUpperCase();
  if (m === 'CASH') return 'CASH';
  if (m === 'CARD') return 'CARD';
  if (m === 'CHECK') return 'CHECK';
  return 'OTHER';
}
