/**
 * Albanian VAT bands: B = 20%, D = 10%, E = 6%, A = exempt.
 *
 * Rates are fractions everywhere in this codebase (0.2 for 20%), but the
 * thresholds are unforgiving about it: a rate of `10` meaning ten percent
 * would clear the `>= 0.19` test and be filed as twenty percent. Since
 * nothing above 100% is a real VAT rate, treat anything over 1 as a
 * percentage rather than trusting it into the wrong band.
 */
export function mapVatRateToCode(vatRate: number): string {
  let r = Number(vatRate);
  if (!Number.isFinite(r) || r <= 0) return 'A';
  if (r > 1) r = r / 100;
  if (r >= 0.19) return 'B';
  if (r >= 0.09) return 'D';
  if (r >= 0.05) return 'E';
  return 'A';
}

export function mapPaymentMethod(method: string): string {
  const m = String(method || '')
    .trim()
    .toUpperCase();
  if (m === 'CASH') return 'CASH';
  if (m === 'CARD') return 'CARD';
  if (m === 'CHECK') return 'CHECK';
  return 'OTHER';
}
