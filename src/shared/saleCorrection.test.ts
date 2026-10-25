import { describe, expect, it } from 'vitest';
import { lineGross, planSaleCorrection } from './saleCorrection';

const sale = {
  status: 'PAID',
  total: 1500,
  vatEnabled: true,
  // Rates are fractions, the way the ledger stores them: 0.2 is Albania's 20%.
  items: [
    { id: 1, name: 'Tavë kosi', qty: 2, unitPrice: 500, vatRate: 0.2 },
    { id: 2, name: 'Kafe', qty: 1, unitPrice: 200, vatRate: 0.2 },
    { id: 3, name: 'Ujë', qty: 1, unitPrice: 300, vatRate: 0.2 },
  ],
};

function ok(result: ReturnType<typeof planSaleCorrection>) {
  if (!result.ok) throw new Error(`expected a plan, got ${result.error}`);
  return result.plan;
}

describe('planSaleCorrection — cancellation', () => {
  it('takes the whole invoice off', () => {
    const plan = ok(
      planSaleCorrection(sale, {
        kind: 'CANCEL',
        reason: 'Guest never served',
      }),
    );

    expect(plan.cancelsSale).toBe(true);
    expect(plan.amountDelta).toBe(-1500);
    expect(plan.nextTotal).toBe(0);
    expect(plan.struckItemIds).toEqual([1, 2, 3]);
  });

  it('reverses the invoice total, not the sum of the lines', () => {
    // A 10% whole-bill discount made the invoice total less than its lines.
    // The cancellation has to match the document that was filed.
    const discounted = { ...sale, total: 1350 };

    expect(
      ok(
        planSaleCorrection(discounted, { kind: 'CANCEL', reason: 'Duplicate' }),
      ).amountDelta,
    ).toBe(-1350);
  });
});

describe('planSaleCorrection — corrective', () => {
  it('strikes one line and leaves the rest standing', () => {
    const plan = ok(
      planSaleCorrection(sale, {
        kind: 'CORRECTIVE',
        itemIds: [2],
        reason: 'Charged twice for the coffee',
      }),
    );

    expect(plan.cancelsSale).toBe(false);
    expect(plan.amountDelta).toBe(-200);
    expect(plan.nextTotal).toBe(1300);
    expect(plan.struckItemIds).toEqual([2]);
  });

  it('recomputes net and VAT from what survives', () => {
    const plan = ok(
      planSaleCorrection(sale, {
        kind: 'CORRECTIVE',
        itemIds: [1],
        reason: 'Wrong dish',
      }),
    );

    // 500 gross left at 20% → 416.67 net + 83.33 VAT.
    expect(plan.nextSubtotal + plan.nextVat).toBeCloseTo(500, 2);
    expect(plan.nextVat).toBeCloseTo(83.33, 2);
  });

  it('splits VAT from what the discounted sale still totals', () => {
    // 1500 of lines sold for 1350. Striking the 300 water leaves 1050 owed;
    // its VAT is 1050 / 1.2 × 0.2, not the VAT of 1200 at menu price.
    const plan = ok(
      planSaleCorrection(
        { ...sale, total: 1350 },
        { kind: 'CORRECTIVE', itemIds: [3], reason: 'Not served' },
      ),
    );
    expect(plan.nextTotal).toBe(1050);
    expect(plan.nextVat).toBe(175);
    expect(plan.nextSubtotal).toBe(875);
  });

  it('refuses to strike every line — that is a cancellation', () => {
    expect(
      planSaleCorrection(sale, {
        kind: 'CORRECTIVE',
        itemIds: [1, 2, 3],
        reason: 'All wrong',
      }),
    ).toEqual({ ok: false, error: 'use-cancel' });
  });

  it('ignores a line named twice', () => {
    const plan = ok(
      planSaleCorrection(sale, {
        kind: 'CORRECTIVE',
        itemIds: [2, 2],
        reason: 'Charged twice',
      }),
    );

    expect(plan.struckItemIds).toEqual([2]);
    expect(plan.amountDelta).toBe(-200);
  });

  it('rejects a line that is not on this sale', () => {
    expect(
      planSaleCorrection(sale, {
        kind: 'CORRECTIVE',
        itemIds: [99],
        reason: 'Wrong dish',
      }),
    ).toEqual({ ok: false, error: 'unknown-line' });
  });

  it('rejects a line an earlier correction already struck', () => {
    const corrected = {
      ...sale,
      items: [
        { ...sale.items[0]!, voidedAt: '2026-09-08T10:00:00.000Z' },
        ...sale.items.slice(1),
      ],
    };

    expect(
      planSaleCorrection(corrected, {
        kind: 'CORRECTIVE',
        itemIds: [1],
        reason: 'Again',
      }),
    ).toEqual({ ok: false, error: 'line-already-void' });
  });

  it('cancels the sale when the last standing line is struck', () => {
    const nearlyGone = {
      ...sale,
      total: 300,
      items: [
        { ...sale.items[0]!, voidedAt: '2026-09-08T10:00:00.000Z' },
        { ...sale.items[1]!, voidedAt: '2026-09-08T10:00:00.000Z' },
        sale.items[2]!,
      ],
    };

    // The only line left is 3, so this is not `use-cancel` territory only
    // because CANCEL is what the caller asked for.
    const plan = ok(
      planSaleCorrection(nearlyGone, { kind: 'CANCEL', reason: 'Rest voided' }),
    );
    expect(plan.struckItemIds).toEqual([3]);
    expect(plan.nextTotal).toBe(0);
  });

  it('never drives a total below zero', () => {
    const mismatched = { ...sale, total: 100 };

    expect(
      ok(
        planSaleCorrection(mismatched, {
          kind: 'CORRECTIVE',
          itemIds: [1],
          reason: 'Overcharged',
        }),
      ).nextTotal,
    ).toBe(0);
  });

  it('needs a reason', () => {
    expect(planSaleCorrection(sale, { kind: 'CANCEL', reason: '  ' })).toEqual({
      ok: false,
      error: 'reason-required',
    });
  });

  it('needs at least one line', () => {
    expect(
      planSaleCorrection(sale, {
        kind: 'CORRECTIVE',
        itemIds: [],
        reason: 'Something',
      }),
    ).toEqual({ ok: false, error: 'no-lines' });
  });
});

describe('planSaleCorrection — guards', () => {
  it('refuses a sale that was never settled', () => {
    expect(
      planSaleCorrection(
        { ...sale, status: 'OPEN' },
        { kind: 'CANCEL', reason: 'Mistake' },
      ),
    ).toEqual({ ok: false, error: 'not-paid' });
  });

  it('refuses a sale already reversed', () => {
    expect(
      planSaleCorrection(
        { ...sale, status: 'VOID' },
        { kind: 'CANCEL', reason: 'Mistake' },
      ),
    ).toEqual({ ok: false, error: 'already-void' });
  });
});

describe('lineGross', () => {
  it('multiplies quantity by price', () => {
    expect(lineGross({ id: 1, qty: 3, unitPrice: 250 })).toBe(750);
  });

  it('treats missing numbers as nothing', () => {
    expect(lineGross({ id: 1 })).toBe(0);
    expect(lineGross({ id: 1, qty: 2, unitPrice: null })).toBe(0);
  });
});

describe('planSaleCorrection — discount and service charge', () => {
  it('gives back what the guest paid for a dish on a bill with 10% off', () => {
    const plan = ok(
      planSaleCorrection(
        {
          ...sale,
          total: 1350,
          discountAmount: 150,
          discountType: 'PERCENT',
        },
        { kind: 'CORRECTIVE', itemIds: [2], reason: 'Coffee returned' },
      ),
    );
    expect(plan.amountDelta).toBe(-180);
    expect(plan.nextTotal).toBe(1170);
    expect(plan.nextDiscount).toBe(130);
  });

  it('keeps a fixed discount whole while there is something to discount', () => {
    const plan = ok(
      planSaleCorrection(
        { ...sale, total: 1400, discountAmount: 100, discountType: 'AMOUNT' },
        { kind: 'CORRECTIVE', itemIds: [2], reason: 'Coffee returned' },
      ),
    );
    expect(plan.amountDelta).toBe(-200);
    expect(plan.nextDiscount).toBe(100);
  });

  it('caps a fixed discount at what is left', () => {
    // 1500 of dishes with 1200 off: 300 paid. Striking the 1000 tavë leaves
    // 500 of dishes, all of it still covered by the discount.
    const plan = ok(
      planSaleCorrection(
        { ...sale, total: 300, discountAmount: 1200, discountType: 'AMOUNT' },
        { kind: 'CORRECTIVE', itemIds: [1], reason: 'Not served' },
      ),
    );
    expect(plan.amountDelta).toBe(-300);
    expect(plan.nextTotal).toBe(0);
    expect(plan.nextDiscount).toBe(500);
  });

  it('takes a percentage service charge off with the dish', () => {
    const plan = ok(
      planSaleCorrection(
        { ...sale, total: 1650, serviceChargeAmount: 150 },
        { kind: 'CORRECTIVE', itemIds: [3], reason: 'Not served' },
      ),
    );
    expect(plan.amountDelta).toBe(-330);
    expect(plan.struckServiceCharge).toBe(30);
    expect(plan.nextServiceCharge).toBe(120);
  });

  it('leaves a fixed service charge on the bill', () => {
    const plan = ok(
      planSaleCorrection(
        {
          ...sale,
          total: 1650,
          serviceChargeAmount: 150,
          serviceChargeMode: 'AMOUNT',
        },
        { kind: 'CORRECTIVE', itemIds: [3], reason: 'Not served' },
      ),
    );
    expect(plan.amountDelta).toBe(-300);
    expect(plan.struckServiceCharge).toBe(0);
    expect(plan.nextServiceCharge).toBe(150);
  });

  it('applies the discount to the service charge too, as the bill did', () => {
    // 1500 + 10% service = 1650, then 10% off = 1485.
    const plan = ok(
      planSaleCorrection(
        {
          ...sale,
          total: 1485,
          serviceChargeAmount: 150,
          discountAmount: 165,
          discountType: 'PERCENT',
        },
        { kind: 'CORRECTIVE', itemIds: [3], reason: 'Not served' },
      ),
    );
    // 300 water + 30 service, less 10%.
    expect(plan.amountDelta).toBe(-297);
  });
});
