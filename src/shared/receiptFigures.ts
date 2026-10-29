/**
 * The money block of a guest bill or receipt.
 *
 * Built from the same line rounding and VAT split as the payment, the
 * sales ledger and the fiscal invoice, so the paper agrees with them: line
 * amounts add up to the goods total, service and discount move it to the
 * amount charged, and Subtotal + VAT is that amount. The VAT is the tax in
 * what the guest paid; printing the goods' VAT before a discount showed tax
 * the fiscal invoice never filed.
 */
import { roundMoney } from './money';
import {
  effectiveVatRate,
  lineGross,
  liveTicketLines,
  splitChargedNetVat,
  splitGrossVat,
} from './ticketRevenue';

export interface ReceiptFigures {
  /** Σ line amounts, VAT-inclusive. */
  goods: number;
  service: number;
  discount: number;
  /** What the guest is charged. */
  total: number;
  /** `total − vat`. */
  net: number;
  vat: number;
  /**
   * The VAT split by rate, highest rate first: what each rate taxed (`base`,
   * net of VAT) and the VAT on it. The rows add up to `net` and `vat`
   * exactly. Empty with VAT off.
   */
  vatByRate: Array<{ rate: number; base: number; vat: number }>;
}

/**
 * Per-rate rows for {@link ReceiptFigures.vatByRate}. Each line's share of
 * the charged total (service and discount spread like `splitChargedNetVat`)
 * is grouped by rate; whatever the cent rounding leaves goes on the largest
 * band, so the rows match the Subtotal and VAT printed above them.
 */
function vatRows(
  live: ReturnType<typeof liveTicketLines>,
  total: number,
  goods: number,
  net: number,
  vat: number,
  defaultVatRate: number,
): ReceiptFigures['vatByRate'] {
  if (!(goods > 0)) return [];
  const factor = total / goods;
  const byRate = new Map<number, number>();
  for (const it of live) {
    const rate = effectiveVatRate((it as any)?.vatRate, defaultVatRate);
    const key = Math.round(Math.max(0, rate) * 10000) / 10000;
    byRate.set(key, (byRate.get(key) || 0) + lineGross(it) * factor);
  }
  const rows = [...byRate.entries()]
    .map(([rate, gross]) => {
      const split = splitGrossVat(gross, rate);
      return {
        rate,
        base: roundMoney(split.net),
        vat: roundMoney(split.vat),
        gross,
      };
    })
    .sort((a, b) => b.rate - a.rate);
  if (rows.length === 0) return [];
  const biggest = rows.reduce((a, b) => (b.gross > a.gross ? b : a));
  biggest.vat = roundMoney(
    biggest.vat + vat - rows.reduce((t, r) => t + r.vat, 0),
  );
  biggest.base = roundMoney(
    biggest.base + net - rows.reduce((t, r) => t + r.base, 0),
  );
  return rows.map(({ rate, base, vat: v }) => ({ rate, base, vat: v }));
}

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? roundMoney(n) : 0;
}

export function receiptFigures(
  items: unknown,
  meta: Record<string, any> | null | undefined,
  opts: { vatEnabled: boolean; defaultVatRate: number },
): ReceiptFigures {
  const live = liveTicketLines(items);
  const goods = roundMoney(live.reduce((sum, it) => sum + lineGross(it), 0));
  const service = money(meta?.serviceChargeAmount);
  const discount = money(meta?.discountAmount);
  const claimed = Number(meta?.totalAfter);
  const total = Number.isFinite(claimed)
    ? Math.max(0, roundMoney(claimed))
    : Math.max(0, roundMoney(goods + service - discount));
  const vat = opts.vatEnabled
    ? roundMoney(splitChargedNetVat(live, total, true, opts.defaultVatRate).vat)
    : 0;
  const net = roundMoney(total - vat);
  return {
    goods,
    service,
    discount,
    total,
    net,
    vat,
    vatByRate: opts.vatEnabled
      ? vatRows(live, total, goods, net, vat, opts.defaultVatRate)
      : [],
  };
}

/**
 * A money amount for print or screen: whole units as they are, cents only
 * when there are some. Lek prices are whole, but a percent discount, a
 * weighed item or a euro total is not, and rounding those to a whole unit
 * printed a different total from the fiscal invoice.
 */
export function formatMoneyPlain(
  amount: unknown,
  group = '',
  opts: { cents?: boolean } = {},
): string {
  const v = roundMoney(amount);
  const whole = Number.isInteger(v) && !opts.cents;
  const [int, frac] = Math.abs(v)
    .toFixed(whole ? 0 : 2)
    .split('.');
  const grouped = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, group) : int;
  return `${v < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}
