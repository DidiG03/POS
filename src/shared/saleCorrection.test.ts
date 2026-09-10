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
