import { describe, expect, it } from 'vitest';
import { cashDueOf, cashTenderOf, withCashTender } from './cashTender';

describe('cash tendered and change', () => {
  it('keeps the bill as the sale and records what was handed over', () => {
    const t = cashTenderOf({
      method: 'CASH',
      totalAfter: 17.4,
      cashTendered: 20,
    });
    expect(t).toEqual({ due: 17.4, tendered: 20, change: 2.6 });
  });

  it('a cash tip is owed in cash too, so it is not change', () => {
    expect(
      cashTenderOf({
        method: 'CASH',
        totalAfter: 17.4,
        cashTendered: 20,
        tip: { amount: 1.6, method: 'CASH' },
      }),
    ).toEqual({ due: 19, tendered: 20, change: 1 });
  });

  it('cash + card: change is on the cash part only', () => {
    const meta = {
      method: 'MIXED',
      totalAfter: 50,
      splits: [
        { method: 'CASH', amount: 15 },
        { method: 'CARD', amount: 35 },
      ],
      cashTendered: 20,
    };
    expect(cashDueOf(meta)).toBe(15);
    expect(cashTenderOf(meta)).toEqual({ due: 15, tendered: 20, change: 5 });
  });

  it('nothing for card, or when less than owed was typed', () => {
    expect(
      cashTenderOf({ method: 'CARD', totalAfter: 10, cashTendered: 20 }),
    ).toBeNull();
    expect(
      cashTenderOf({ method: 'CASH', totalAfter: 10, cashTendered: 5 }),
    ).toBeNull();
    // An older app's rounded bill counts only when it covers the bill.
    expect(
      cashTenderOf({ method: 'CASH', totalAfter: 5.4, amountPaid: 5 }),
    ).toBeNull();
  });

  it('puts tendered and change on the receipt data', () => {
    expect(
      withCashTender({ method: 'CASH', totalAfter: 17.4, cashTendered: 50 }),
    ).toMatchObject({ cashTendered: 50, cashChange: 32.6 });
    const none = withCashTender({
      method: 'CARD',
      totalAfter: 9,
      cashTendered: 50,
      cashChange: 41,
    });
    expect('cashTendered' in none || 'cashChange' in none).toBe(false);
  });
});
