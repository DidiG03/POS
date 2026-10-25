/**
 * Round to cents, half away from zero, on the decimal the amount reads as.
 *
 * Binary floats store 2.135 as 2.13499…, so `Math.round(x * 100)` took
 * about one half-cent in 160 down a cent (10.075 → 10.07), and the old
 * epsilon nudge only helped near 1. Rounding the 15-significant-digit
 * decimal instead matches what an accountant, the receipt and the tax
 * service compute. Negative amounts (corrections, refunds) mirror positive
 * ones: −1.005 is −1.01, not −1.00.
 */
export function roundMoney(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const abs = Math.abs(n);
  const shown = abs.toPrecision(15);
  // Exponent form only for amounts no till sees: under a millionth (0) or
  // beyond cent precision (left as they are).
  if (/e/i.test(shown)) return abs < 1 ? 0 : n;
  const out = Math.round(Number(`${shown}e2`)) / 100;
  return n < 0 && out !== 0 ? -out : out;
}
