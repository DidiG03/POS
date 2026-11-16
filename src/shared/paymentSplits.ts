/**
 * Paying one bill partly in cash and partly by card.
 *
 * The Pay screen offered cash or card only, so a guest paying part of
 * each was recorded as one of them and the drawer was off by the other
 * part. A split payment is `method: 'MIXED'` with `splits`. The till keeps
 * the card part as sent (that is what the terminal charged) and takes the
 * rest of its own total as cash.
 */
import { roundMoney } from './money';

export type SplitMethod = 'CASH' | 'CARD';
export interface PaymentSplit {
  method: SplitMethod;
  amount: number;
}

export const INVALID_SPLIT = 'INVALID_SPLIT';

function cents(n: unknown): number {
  return Math.round(Number(n || 0) * 100);
}

/**
 * The payment `meta` with its split made exact against `totalAfter` (the
 * till's own total), or why it cannot be taken. Not a split: `splits` is
 * removed so nothing downstream reads a stale one.
 */
export function normalizePaymentSplit(
  meta: Record<string, any>,
): { ok: true; meta: Record<string, any> } | { ok: false; error: string } {
  const method = String(meta?.method || meta?.paymentMethod || '')
    .trim()
    .toUpperCase();
  if (method !== 'MIXED') {
    if (meta && 'splits' in meta) {
      const next = { ...meta };
      delete next.splits;
      return { ok: true, meta: next };
    }
    return { ok: true, meta };
  }
  const totalCents = cents(meta.totalAfter);
  const cardCents = (Array.isArray(meta.splits) ? meta.splits : [])
    .filter((s: any) => String(s?.method || '').toUpperCase() === 'CARD')
    .reduce((a: number, s: any) => a + cents(s?.amount), 0);
  if (!(cardCents > 0) || cardCents >= totalCents) {
    return {
      ok: false,
      error:
        'For cash and card, the card part must be more than 0 and less than the total. Check the amounts and charge again.',
    };
  }
  return {
    ok: true,
    meta: {
      ...meta,
      method: 'MIXED',
      splits: [
        { method: 'CASH', amount: (totalCents - cardCents) / 100 },
        { method: 'CARD', amount: cardCents / 100 },
      ] satisfies PaymentSplit[],
    },
  };
}

/**
 * How much of a sale was paid by each method. A split sale counts its cash
 * part as cash and its card part as card; anything else counts in full
 * under its own method.
 */
export function saleMethodAmounts(
  method: string,
  total: number,
  splits: unknown,
): Array<{ method: string; amount: number }> {
  const m = String(method || '').toUpperCase();
  if (m === 'MIXED' && Array.isArray(splits) && splits.length) {
    const parts = splits
      .map((s: any) => ({
        method: String(s?.method || '').toUpperCase(),
        amount: roundMoney(Number(s?.amount || 0)),
      }))
      .filter(
        (s) => (s.method === 'CASH' || s.method === 'CARD') && s.amount > 0,
      );
    if (parts.length) return parts;
  }
  return [{ method: m || 'MIXED', amount: roundMoney(total) }];
}

/**
 * The split scaled to `amount` (what the invoice adds up to after the
 * till's own rounding): the card part stays, the cash part takes the
 * difference.
 */
export function splitsForAmount(
  splits: unknown,
  amount: number,
): PaymentSplit[] | null {
  const list = saleMethodAmounts('MIXED', amount, splits);
  const card = list.find((s) => s.method === 'CARD');
  if (!card || list.length < 2) return null;
  const cashCents = cents(amount) - cents(card.amount);
  if (cashCents <= 0) return null;
  return [
    { method: 'CASH', amount: cashCents / 100 },
    { method: 'CARD', amount: card.amount },
  ];
}

/**
 * How a refund of a cash-and-card sale splits between the two, in the
 * sale's own proportion: a 40 cash + 60 card sale refunded 10 gives back
 * 4 cash and 6 card. Cents are exact and add up to `refund`, whose sign
 * is kept (a corrective files negative amounts). Null when the sale was
 * not a split.
 */
export function refundSplits(
  splits: unknown,
  saleTotal: number,
  refund: number,
): PaymentSplit[] | null {
  const parts = saleMethodAmounts('MIXED', saleTotal, splits);
  const card = parts.find((p) => p.method === 'CARD');
  // The proportion of the sale as paid. Its total may since have been
  // restated by an earlier refund; the parts were not.
  const total = parts.reduce((a, p) => a + cents(p.amount), 0);
  if (!card || parts.length < 2 || !(total > 0)) return null;
  const sign = refund < 0 ? -1 : 1;
  const refundCents = Math.abs(cents(refund));
  if (!(refundCents > 0)) return null;
  const cardCents = Math.min(
    refundCents,
    Math.round((refundCents * cents(card.amount)) / total),
  );
  const cashCents = refundCents - cardCents;
  const out: PaymentSplit[] = [];
  if (cashCents > 0)
    out.push({ method: 'CASH', amount: (sign * cashCents) / 100 });
  if (cardCents > 0)
    out.push({ method: 'CARD', amount: (sign * cardCents) / 100 });
  return out;
}

/** The cash part of a refund (positive), whatever the sale's method. */
export function cashPartOfRefund(
  method: string,
  splits: unknown,
  saleTotal: number,
  refund: number,
): number {
  const m = String(method || '').toUpperCase();
  const amount = Math.abs(cents(refund)) / 100;
  if (m === 'CASH') return amount;
  if (m !== 'MIXED') return 0;
  const parts = refundSplits(splits, saleTotal, amount);
  return parts?.find((p) => p.method === 'CASH')?.amount ?? 0;
}
