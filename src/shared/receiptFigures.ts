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
  lineGross,
  liveTicketLines,
  splitChargedNetVat,
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
  return {
    goods,
    service,
    discount,
    total,
    net: roundMoney(total - vat),
    vat,
  };
}

/**
 * A money amount for print or screen: whole units as they are, cents only
 * when there are some. Lek prices are whole, but a percent discount, a
 * weighed item or a euro total is not, and rounding those to a whole unit
 * printed a different total from the fiscal invoice.
 */
export function formatMoneyPlain(amount: unknown, group = ''): string {
  const v = roundMoney(amount);
  const whole = Number.isInteger(v);
  const [int, frac] = Math.abs(v)
    .toFixed(whole ? 0 : 2)
    .split('.');
  const grouped = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, group) : int;
  return `${v < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}
