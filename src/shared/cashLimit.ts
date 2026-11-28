/**
 * Albania's cap on cash per transaction.
 *
 * A sale paid in cash may not exceed 500,000 ALL; from 30 January 2026 a
 * sale to a business (the buyer has a NIPT) may not exceed 100,000 ALL in
 * cash. The tax service refuses such an invoice ("Totali nuk mund të jetë
 * më shumë se 500000.00 ALL"), but only after the till had taken the
 * payment and closed the table, so the sale stood unfiled. The till now
 * checks the cash part before it takes anything; the Pay screen shows the
 * same limit so the waiter can take card or split instead.
 *
 * Applies only on tills that file with the Albanian tax service
 * (fiskalizimi on). The cap is on the invoice total whenever the invoice
 * has any cash on it: a bill over it is paid fully by card, or split by
 * seat into bills each under it. Card only is never capped.
 */
import { roundMoney } from './money';

export const CASH_LIMIT_EXCEEDED = 'CASH_LIMIT_EXCEEDED';

/** ALL per transaction, sales to consumers. */
export const CASH_CAP_B2C_LEK = 500_000;
/** ALL per transaction, sales to a business with a NIPT. */
export const CASH_CAP_B2B_LEK = 100_000;
/** The B2B cap applies to sales on or after this day (Tirana time). */
export const CASH_CAP_B2B_FROM = '2026-01-30';

export interface CashLimit {
  /** The cap in lekë. */
  capLek: number;
  /**
   * The cap in the venue's currency: the largest bill that may be paid
   * with any cash at all. Above it the whole bill goes on card.
   */
  maxCash: number;
  currency: string;
  b2b: boolean;
}

export type CashLimitCheck =
  | { ok: true; limit: CashLimit | null }
  | {
      ok: false;
      code: typeof CASH_LIMIT_EXCEEDED;
      error: string;
      permanent: true;
      limit: CashLimit;
      /** The cash part of this payment, in the venue's currency. */
      cash: number;
      cashLek: number;
    };

const upper = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toUpperCase();

/** The buyer's NIPT on this payment, if the sale is to a business. */
export function buyerNipt(meta: Record<string, any> | null | undefined) {
  const m = meta || {};
  const buyer = m.buyer && typeof m.buyer === 'object' ? m.buyer : null;
  const fromBuyer =
    buyer && (!buyer.buyerIDType || upper(buyer.buyerIDType) === 'NUIS')
      ? buyer.buyerID
      : '';
  const nipt = upper(m.buyerNipt || fromBuyer).replace(/\s+/g, '');
  return nipt || null;
}

function tiranaDay(at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Tirane',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Lekë per one unit of the venue's currency, or null when unknown. */
export function lekRate(settings: any): number | null {
  const currency = upper(settings?.currency || 'ALL');
  if (currency === 'ALL') return 1;
  const fiscal = settings?.fiscal || {};
  const per = Number(fiscal.exchangeRates?.[currency]);
  if (Number.isFinite(per) && per > 0) return per;
  if (currency === 'EUR') {
    const eur = Number(fiscal.eurExchangeRate);
    if (Number.isFinite(eur) && eur > 0) return eur;
  }
  return null;
}

/**
 * The cash limit for a sale, or null where none applies: fiskalizimi off,
 * or a foreign currency without a rate (the invoice cannot be filed then
 * anyway, and says so).
 */
export function cashLimitFor(
  settings: any,
  meta?: Record<string, any> | null,
  at: Date = new Date(),
): CashLimit | null {
  if (settings?.fiscal?.enabled !== true) return null;
  const rate = lekRate(settings);
  if (!rate) return null;
  const b2b = !!buyerNipt(meta) && tiranaDay(at) >= CASH_CAP_B2B_FROM;
  const capLek = b2b ? CASH_CAP_B2B_LEK : CASH_CAP_B2C_LEK;
  return {
    capLek,
    // Rounded down: the cash shown as allowed must convert to no more
    // than the cap.
    maxCash: Math.floor((capLek / rate) * 100 + 1e-6) / 100,
    currency: upper(settings?.currency || 'ALL'),
    b2b,
  };
}

/** The cash part of a payment, in the venue's currency. */
export function cashPartOf(meta: Record<string, any> | null | undefined) {
  const m = meta || {};
  const method = upper(m.method || m.paymentMethod);
  if (method === 'CASH') return roundMoney(Number(m.totalAfter) || 0);
  if (method === 'MIXED') {
    const splits = Array.isArray(m.splits) ? m.splits : [];
    const cash = splits
      .filter((s: any) => upper(s?.method) === 'CASH')
      .reduce((a: number, s: any) => a + (Number(s?.amount) || 0), 0);
    if (cash > 0) return roundMoney(cash);
    // Before the split is made exact: the total less the card part.
    const card = splits
      .filter((s: any) => upper(s?.method) === 'CARD')
      .reduce((a: number, s: any) => a + (Number(s?.amount) || 0), 0);
    return roundMoney(Math.max(0, (Number(m.totalAfter) || 0) - card));
  }
  return 0;
}

const fmt = (n: number) =>
  n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

/** The message staff see. */
export function cashLimitMessage(limit: CashLimit): string {
  const cap = `${fmt(limit.capLek)} ALL`;
  const who = limit.b2b ? ' to a business' : '';
  const max =
    limit.currency === 'ALL'
      ? ''
      : ` (${fmt(limit.maxCash)} ${limit.currency})`;
  return `Bills over ${cap}${max}${who} must be paid fully by card in Albania. To take some cash, split the bill by seat into bills of no more than ${fmt(limit.maxCash)} ${limit.currency} each.`;
}

/** Null-safe check of one payment against the cap. */
export function checkCashLimit(
  settings: any,
  meta: Record<string, any> | null | undefined,
  at: Date = new Date(),
): CashLimitCheck {
  const limit = cashLimitFor(settings, meta, at);
  if (!limit) return { ok: true, limit: null };
  const cash = cashPartOf(meta);
  const rate = lekRate(settings) ?? 1;
  const cashLek = roundMoney(cash * rate);
  // The cap is on the invoice, not on the cash part: easyPos refuses an
  // invoice over it that has any cash on it, so a €5,830 bill paid €100
  // cash + the rest by card was taken, the table closed, and the invoice
  // refused (busy-service run 2, #1). Card only is never capped.
  const billLek = roundMoney((Number(meta?.totalAfter) || 0) * rate);
  if (!(cash > 0) || billLek <= limit.capLek + 1e-9) return { ok: true, limit };
  return {
    ok: false,
    code: CASH_LIMIT_EXCEEDED,
    error: cashLimitMessage(limit),
    permanent: true,
    limit,
    cash,
    cashLek,
  };
}

/**
 * The answer to "prepare payment": the cash limit for this sale and, when
 * the screen says how it means to pay, whether the till will take it.
 * Called with no payment (the Pay screen just opened) it only reports the
 * limit.
 */
export function preparePaymentAnswer(
  settings: any,
  input: unknown,
  at: Date = new Date(),
):
  | { ok: true; cashLimit: CashLimit | null }
  | (Extract<CashLimitCheck, { ok: false }> & { cashLimit: CashLimit }) {
  const p = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    any
  >;
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : p;
  if (!meta.method && !meta.paymentMethod) {
    return { ok: true, cashLimit: cashLimitFor(settings, meta, at) };
  }
  const check = checkCashLimit(settings, meta, at);
  if (check.ok) return { ok: true, cashLimit: check.limit };
  return { ...check, cashLimit: check.limit };
}
