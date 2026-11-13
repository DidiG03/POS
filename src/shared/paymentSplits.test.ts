import { describe, expect, it } from 'vitest';
import {
  normalizePaymentSplit,
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
