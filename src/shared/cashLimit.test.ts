import { describe, expect, it } from 'vitest';
import {
  CASH_LIMIT_EXCEEDED,
  cashLimitFor,
  checkCashLimit,
  preparePaymentAnswer,
} from './cashLimit';

const lek = { currency: 'ALL', fiscal: { enabled: true } };
const euro = {
  currency: 'EUR',
  fiscal: { enabled: true, eurExchangeRate: 98 },
};
const after = new Date('2026-06-01T10:00:00Z');
const before = new Date('2026-01-29T10:00:00Z');
const cash = (totalAfter: number, extra: Record<string, unknown> = {}) => ({
  kind: 'PAYMENT',
  method: 'CASH',
  totalAfter,
  ...extra,
});

describe('Albania cash cap', () => {
  it('allows up to 500,000 ALL and refuses a lek more', () => {
    expect(checkCashLimit(lek, cash(499_999), after).ok).toBe(true);
    expect(checkCashLimit(lek, cash(500_000), after).ok).toBe(true);
    const r = checkCashLimit(lek, cash(500_001), after);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(CASH_LIMIT_EXCEEDED);
    expect(r.limit.maxCash).toBe(500_000);
    expect(r.error).toMatch(/500,000 ALL/);
  });

  it('caps a sale to a business at 100,000 ALL from 30 January 2026', () => {
    const b2b = { buyer: { buyerIDType: 'NUIS', buyerID: 'L12345678A' } };
    expect(checkCashLimit(lek, cash(100_000, b2b), after).ok).toBe(true);
    const r = checkCashLimit(lek, cash(100_001, b2b), after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.limit).toMatchObject({ b2b: true, capLek: 100_000 });
    expect(
      checkCashLimit(lek, cash(100_001, { buyerNipt: 'L1' }), after).ok,
    ).toBe(false);
    // Before the date the consumer cap applies.
    expect(checkCashLimit(lek, cash(400_000, b2b), before).ok).toBe(true);
  });

  it('converts a euro bill with the configured rate', () => {
    // 200 Ribeye + 10% service = €5,830 = 571,340 ALL.
    const r = checkCashLimit(euro, cash(5830), after);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cashLek).toBe(571_340);
      expect(r.limit.maxCash).toBe(5102.04);
      expect(r.error).toMatch(/5,102\.04 EUR/);
    }
    expect(checkCashLimit(euro, cash(5102.04), after).ok).toBe(true);
    expect(checkCashLimit(euro, cash(5102.05), after).ok).toBe(false);
  });

  it('caps the bill, not the cash part, whenever any cash is on it', () => {
    const mixed = (cashPart: number, card: number) => ({
      kind: 'PAYMENT',
      method: 'MIXED',
      totalAfter: cashPart + card,
      splits: [
        { method: 'CASH', amount: cashPart },
        { method: 'CARD', amount: card },
      ],
    });
    // €5,830 (571,340 ALL) with €100 cash: easyPos refuses the invoice.
    const r = checkCashLimit(euro, mixed(100, 5730), after);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be paid fully by card/);
    expect(checkCashLimit(euro, mixed(0.01, 5829.99), after).ok).toBe(false);
    // Before the split is made exact: total less the card part.
    expect(
      checkCashLimit(
        euro,
        {
          method: 'MIXED',
          totalAfter: 5830,
          splits: [{ method: 'CARD', amount: 5729 }],
        },
        after,
      ).ok,
    ).toBe(false);
    // Card only is never capped.
    expect(
      checkCashLimit(euro, { method: 'CARD', totalAfter: 5830 }, after).ok,
    ).toBe(true);
    // At or under the cap, any mix of cash and card is fine.
    expect(checkCashLimit(euro, mixed(5000, 102.04), after).ok).toBe(true);
    expect(checkCashLimit(lek, mixed(250_000, 250_000), after).ok).toBe(true);
    expect(checkCashLimit(lek, mixed(1, 500_000), after).ok).toBe(false);
  });

  it('the bill split into two bills under the cap takes cash on each', () => {
    // €5,830 split by seat into €2,915 + €2,915, each 285,670 ALL.
    for (const half of [2915, 2915]) {
      expect(checkCashLimit(euro, cash(half), after).ok).toBe(true);
      expect(
        checkCashLimit(
          euro,
          {
            method: 'MIXED',
            totalAfter: half,
            splits: [
              { method: 'CASH', amount: 100 },
              { method: 'CARD', amount: half - 100 },
            ],
          },
          after,
        ).ok,
      ).toBe(true);
    }
  });

  it('a bill to a business over 100,000 ALL takes no cash at all', () => {
    const b2b = { buyerNipt: 'L12345678A' };
    expect(
      checkCashLimit(
        lek,
        {
          method: 'MIXED',
          totalAfter: 100_001,
          splits: [
            { method: 'CASH', amount: 1 },
            { method: 'CARD', amount: 100_000 },
          ],
          ...b2b,
        },
        after,
      ).ok,
    ).toBe(false);
    expect(
      checkCashLimit(
        lek,
        {
          method: 'MIXED',
          totalAfter: 100_000,
          splits: [
            { method: 'CASH', amount: 50_000 },
            { method: 'CARD', amount: 50_000 },
          ],
          ...b2b,
        },
        after,
      ).ok,
    ).toBe(true);
    expect(
      checkCashLimit(
        lek,
        { method: 'CARD', totalAfter: 900_000, ...b2b },
        after,
      ).ok,
    ).toBe(true);
  });

  it('leaves tills that do not file in Albania alone', () => {
    expect(
      cashLimitFor({ currency: 'ALL', fiscal: { enabled: false } }),
    ).toBeNull();
    expect(checkCashLimit({ currency: 'EUR' }, cash(1e9), after).ok).toBe(true);
    // No rate for the currency: cannot be filed anyway, not capped here.
    expect(
      checkCashLimit(
        { currency: 'USD', fiscal: { enabled: true } },
        cash(1e9),
        after,
      ).ok,
    ).toBe(true);
  });

  it('answers prepare-payment with the limit, and refuses an over-cap cash plan', () => {
    expect(preparePaymentAnswer(euro, null, after)).toMatchObject({
      ok: true,
      cashLimit: { maxCash: 5102.04, currency: 'EUR' },
    });
    expect(
      preparePaymentAnswer(euro, { method: 'CASH', totalAfter: 5830 }, after),
    ).toMatchObject({ ok: false, code: CASH_LIMIT_EXCEEDED });
    expect(
      preparePaymentAnswer(euro, { method: 'CARD', totalAfter: 5830 }, after)
        .ok,
    ).toBe(true);
  });
});
