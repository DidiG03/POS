/**
 * Revenue helpers: TicketLog rows store line items in `itemsJson`; voided lines
 * stay on the row with `voided: true` and must be excluded from net/VAT sums
 * everywhere we treat a row as revenue (same rule as admin analytics).
 */

export function liveTicketLines(itemsJson: unknown): any[] {
  const arr = Array.isArray(itemsJson) ? itemsJson : [];
  return arr.filter((it: any) => !it?.voided);
}

/**
 * Resolve the VAT rate to apply to a line. A line that carries no rate
 * (or a 0 rate from legacy/cloud-synced data) falls back to the business
 * default (Albanian standard 20% → 0.2) so fiscalized receipts never
 * silently report 0% VAT. Pass `defaultRate = 0` to opt out of the
 * fallback (e.g. genuinely VAT-exempt contexts).
 */
export function effectiveVatRate(
  rawRate: unknown,
  defaultRate: unknown = 0,
): number {
  const r = Number(rawRate);
  if (Number.isFinite(r) && r > 0) return r;
  const d = Number(defaultRate);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Albanian fiscalization (and consumer-price law) treats displayed
 * prices as VAT-INCLUSIVE: the gross already contains the tax. This
 * extracts the contained VAT rather than adding it on top — so the
 * customer total stays equal to the menu price and matches the amount
 * sent to the fiscal provider (easyPos), which performs the same
 * inclusive extraction from `price`.
 *
 *   net = gross / (1 + rate)
 *   vat = gross − net
 */
export function splitGrossVat(
  gross: number,
  rate: number,
): { net: number; vat: number } {
  const g = Number(gross);
  if (!Number.isFinite(g) || g === 0) return { net: 0, vat: 0 };
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return { net: g, vat: 0 };
  const net = g / (1 + r);
  return { net, vat: g - net };
}

export function sumTicketLinesNetVat(
  itemsJson: unknown,
  vatEnabled = true,
  defaultVatRate = 0,
): {
  net: number;
  vat: number;
} {
  const lines = liveTicketLines(itemsJson);
  let net = 0;
  let vat = 0;
  for (const it of lines) {
    const qty = Number((it as any)?.qty || 1);
    const unit = Number((it as any)?.unitPrice || 0);
    const gross = unit * qty;
    if (!vatEnabled) {
      net += gross;
      continue;
    }
    const rate = effectiveVatRate((it as any)?.vatRate, defaultVatRate);
    const split = splitGrossVat(gross, rate);
    net += split.net;
    vat += split.vat;
  }
  return { net, vat };
}
