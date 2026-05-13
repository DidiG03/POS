/**
 * Revenue helpers: TicketLog rows store line items in `itemsJson`; voided lines
 * stay on the row with `voided: true` and must be excluded from net/VAT sums
 * everywhere we treat a row as revenue (same rule as admin analytics).
 */

export function liveTicketLines(itemsJson: unknown): any[] {
  const arr = Array.isArray(itemsJson) ? itemsJson : [];
  return arr.filter((it: any) => !it?.voided);
}

export function sumTicketLinesNetVat(itemsJson: unknown): {
  net: number;
  vat: number;
} {
  const lines = liveTicketLines(itemsJson);
  let net = 0;
  let vat = 0;
  for (const it of lines) {
    const qty = Number((it as any)?.qty || 1);
    const unit = Number((it as any)?.unitPrice || 0);
    const vatRate = Number((it as any)?.vatRate || 0);
    const lineNet = unit * qty;
    net += lineNet;
    vat += lineNet * vatRate;
  }
  return { net, vat };
}
