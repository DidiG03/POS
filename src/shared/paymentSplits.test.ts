import { describe, expect, it } from 'vitest';
import {
  cashPartOfRefund,
  normalizePaymentSplit,
  refundSplits,
  saleMethodAmounts,
  splitsForAmount,
} from './paymentSplits';

describe('normalizePaymentSplit', () => {
  it('takes the card part as sent and the rest of the till total as cash', () => {
    const r = normalizePaymentSplit({
      method: 'MIXED',
      totalAfter: 47.5,
      splits: [
        { method: 'CARD', amount: 30 },
        { method: 'CASH', amount: 99 },
      ],
    });
    expect(r).toEqual({
      ok: true,
      meta: {
        method: 'MIXED',
        totalAfter: 47.5,
        splits: [
          { method: 'CASH', amount: 17.5 },
          { method: 'CARD', amount: 30 },
        ],
      },
    });
  });

  it('refuses a card part of nothing, or of the whole bill', () => {
    for (const card of [0, 47.5, 60]) {
      expect(
        normalizePaymentSplit({
          method: 'MIXED',
          totalAfter: 47.5,
          splits: [{ method: 'CARD', amount: card }],
        }).ok,
      ).toBe(false);
    }
  });

  it('drops a leftover split from a plain payment', () => {
    const r = normalizePaymentSplit({ method: 'CASH', splits: [{}] });
    expect(r).toEqual({ ok: true, meta: { method: 'CASH' } });
  });
});

describe('saleMethodAmounts', () => {
  it('counts each part of a split under its own method', () => {
    expect(
      saleMethodAmounts('MIXED', 47.5, [
        { method: 'CASH', amount: 17.5 },
        { method: 'CARD', amount: 30 },
      ]),
    ).toEqual([
      { method: 'CASH', amount: 17.5 },
      { method: 'CARD', amount: 30 },
    ]);
    expect(saleMethodAmounts('CARD', 10, null)).toEqual([
      { method: 'CARD', amount: 10 },
    ]);
    // An old mixed sale without its parts still counts somewhere.
    expect(saleMethodAmounts('MIXED', 10, undefined)).toEqual([
      { method: 'MIXED', amount: 10 },
    ]);
  });
});

describe('splitsForAmount', () => {
  it('keeps the card part and puts rounding on the cash part', () => {
    expect(
      splitsForAmount(
        [
          { method: 'CASH', amount: 17.5 },
          { method: 'CARD', amount: 30 },
        ],
        47.51,
      ),
    ).toEqual([
      { method: 'CASH', amount: 17.51 },
      { method: 'CARD', amount: 30 },
    ]);
  });
});

describe('refundSplits', () => {
  const splits = [
    { method: 'CASH', amount: 40 },
    { method: 'CARD', amount: 60 },
  ];
  it('splits a refund in the sale proportion, to the cent', () => {
    expect(refundSplits(splits, 100, -10)).toEqual([
      { method: 'CASH', amount: -4 },
      { method: 'CARD', amount: -6 },
    ]);
    const odd = refundSplits(splits, 100, 3.33)!;
    expect(odd.reduce((a, p) => a + p.amount, 0)).toBeCloseTo(3.33, 10);
  });
  it('keeps the proportion after the total was restated', () => {
    expect(refundSplits(splits, 70, 10)).toEqual([
      { method: 'CASH', amount: 4 },
      { method: 'CARD', amount: 6 },
    ]);
  });
  it('is null for a sale that was not split', () => {
    expect(refundSplits(undefined, 100, 10)).toBeNull();
  });
});

describe('cashPartOfRefund', () => {
  const splits = [
    { method: 'CASH', amount: 40 },
    { method: 'CARD', amount: 60 },
  ];
  it('is all of a cash refund and none of a card one', () => {
    expect(cashPartOfRefund('CASH', undefined, 50, -12)).toBe(12);
    expect(cashPartOfRefund('CARD', undefined, 50, -12)).toBe(0);
  });
  it('is the cash share of a split refund', () => {
    expect(cashPartOfRefund('MIXED', splits, 100, -25)).toBe(10);
  });
});
