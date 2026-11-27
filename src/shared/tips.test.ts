import { describe, expect, it } from 'vitest';
import { normalizePaymentSplit } from './paymentSplits';
import { normalizeTip, sumTips, tipOf } from './tips';
import { checkCashLimit } from './cashLimit';

const pay = (extra: Record<string, unknown>) => ({
  kind: 'PAYMENT',
  method: 'CARD',
  totalAfter: 40,
  ...extra,
});

describe('tips', () => {
  it('takes an amount or a % of the bill, on the method paid', () => {
    const card = normalizeTip(pay({ tipAmount: '4,50' }));
    expect(card.ok && card.meta.tip).toEqual({ amount: 4.5, method: 'CARD' });
    const cash = normalizeTip(pay({ method: 'CASH', tipPercent: 10 }));
    expect(cash.ok && cash.meta.tip).toEqual({
      amount: 4,
      method: 'CASH',
      percent: 10,
    });
    // The sale total is never changed by a tip.
    expect(card.ok && card.meta.totalAfter).toBe(40);
  });

  it('a cash + card payment puts the tip on the part chosen (card by default)', () => {
    const split = normalizePaymentSplit({
      method: 'MIXED',
      totalAfter: 40,
      splits: [{ method: 'CARD', amount: 25 }],
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const onCard = normalizeTip({ ...split.meta, tipAmount: 3 });
    expect(onCard.ok && onCard.meta.tip).toEqual({ amount: 3, method: 'CARD' });
    const inCash = normalizeTip({
      ...split.meta,
      tipAmount: 3,
      tipMethod: 'CASH',
    });
    expect(inCash.ok && inCash.meta.tip).toEqual({ amount: 3, method: 'CASH' });
    // The split itself is untouched: 15 cash + 25 card = the bill.
    expect(inCash.ok && inCash.meta.splits).toEqual([
      { method: 'CASH', amount: 15 },
      { method: 'CARD', amount: 25 },
    ]);
  });

  it('refuses a negative tip, or one bigger than the bill', () => {
    expect(normalizeTip(pay({ tipAmount: -1 })).ok).toBe(false);
    expect(normalizeTip(pay({ tipAmount: 41 })).ok).toBe(false);
    expect(normalizeTip(pay({ tipPercent: 150 })).ok).toBe(false);
    expect(normalizeTip(pay({ tipAmount: 40 })).ok).toBe(true);
  });

  it('no tip leaves no tip behind', () => {
    const r = normalizeTip(pay({ tipAmount: 0, tip: { amount: 9 } }));
    expect(r.ok && 'tip' in r.meta).toBe(false);
    expect(tipOf({})).toBeNull();
  });

  it('a cash tip does not count towards the cash cap (it is not invoiced)', () => {
    const r = normalizeTip({
      method: 'CASH',
      totalAfter: 500_000,
      tipAmount: 10_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      checkCashLimit({ currency: 'ALL', fiscal: { enabled: true } }, r.meta).ok,
    ).toBe(true);
  });

  it('sums by method and by waiter, and both add up to the total', () => {
    const t = sumTips([
      { tip: 1.1, meta: { tip: { method: 'CARD' } }, userId: 1, userName: 'A' },
      { tip: 2.2, meta: { tip: { method: 'CASH' } }, userId: 1, userName: 'A' },
      { tip: 3.3, meta: { tip: { method: 'CARD' } }, userId: 2, userName: 'B' },
      { tip: 0, meta: {}, userId: 3 },
    ]);
    expect(t.total).toBe(6.6);
    expect(t.count).toBe(3);
    const sum = (rows: Array<{ amount: number }>) =>
      Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100;
    expect(sum(t.byMethod)).toBe(6.6);
    expect(sum(t.byWaiter)).toBe(6.6);
  });
});
