import { describe, it, expect } from 'vitest';
import {
  roundMoney,
  sumLineItemsGross,
  computeDiscountAmount,
  computeServiceChargeAmount,
  computeAuthoritativeTotals,
  validatePaymentTotals,
  applyAuthoritativeTotals,
} from './pricing';

const line = (unitPrice: number, qty: number, vatRate = 0.2) => ({
  unitPrice,
  qty,
  vatRate,
});

describe('roundMoney', () => {
  it('rounds to cents', () => {
    expect(roundMoney(1.234)).toBe(1.23);
    expect(roundMoney(1.235)).toBe(1.24);
    expect(roundMoney(10)).toBe(10);
  });

  it('rounds half-cents up despite binary representation', () => {
    // 1.005 is stored as 1.00499999999999989, which naive
    // Math.round(x * 100) / 100 rounds DOWN to 1.00.
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(8.615)).toBe(8.62);
  });

  it('treats non-numeric input as zero', () => {
    expect(roundMoney(undefined)).toBe(0);
    expect(roundMoney('abc')).toBe(0);
    expect(roundMoney(NaN)).toBe(0);
    expect(roundMoney(Infinity)).toBe(0);
  });
});

describe('sumLineItemsGross', () => {
  it('sums VAT-inclusive line totals', () => {
    expect(sumLineItemsGross([line(9.99, 3), line(2.5, 2)])).toBe(34.97);
  });

  it('excludes voided lines', () => {
    const items = [line(10, 1), { ...line(10, 1), voided: true }];
    expect(sumLineItemsGross(items)).toBe(10);
  });

  it('ignores malformed lines rather than producing NaN', () => {
    const items = [line(10, 1), { unitPrice: 'x', qty: 2 }];
    expect(sumLineItemsGross(items)).toBe(10);
  });

  it('handles a non-array safely', () => {
    expect(sumLineItemsGross(null)).toBe(0);
  });
});

describe('computeDiscountAmount', () => {
  it('computes percent and fixed discounts', () => {
    expect(computeDiscountAmount(200, 'PERCENT', 15)).toBe(30);
    expect(computeDiscountAmount(200, 'AMOUNT', 25)).toBe(25);
  });

  it('never exceeds the base it applies to', () => {
    expect(computeDiscountAmount(50, 'AMOUNT', 500)).toBe(50);
    expect(computeDiscountAmount(50, 'PERCENT', 250)).toBe(50);
  });

  it('returns zero for NONE or non-positive input', () => {
    expect(computeDiscountAmount(100, 'NONE', 10)).toBe(0);
    expect(computeDiscountAmount(100, 'PERCENT', 0)).toBe(0);
    expect(computeDiscountAmount(100, 'PERCENT', -5)).toBe(0);
    expect(computeDiscountAmount(0, 'PERCENT', 10)).toBe(0);
  });
});

describe('computeServiceChargeAmount', () => {
  const cfg = { enabled: true, mode: 'PERCENT' as const, value: 10 };

  it('applies only when enabled and toggled on', () => {
    expect(computeServiceChargeAmount(100, cfg, true)).toBe(10);
    expect(computeServiceChargeAmount(100, cfg, false)).toBe(0);
    expect(
      computeServiceChargeAmount(100, { ...cfg, enabled: false }, true),
    ).toBe(0);
  });

  it('supports a flat amount', () => {
    expect(
      computeServiceChargeAmount(
        100,
        { enabled: true, mode: 'AMOUNT', value: 5 },
        true,
      ),
    ).toBe(5);
  });
});

describe('computeAuthoritativeTotals', () => {
  it('extracts VAT inclusively so net + vat equals the menu total', () => {
    const t = computeAuthoritativeTotals({
      items: [line(120, 1, 0.2)],
      vatEnabled: true,
      defaultVatRate: 0.2,
    });
    expect(t.baseTotal).toBe(120);
    expect(t.vat).toBe(20);
    expect(t.net).toBe(100);
    expect(t.totalDue).toBe(120);
  });

  it('reports zero VAT when VAT is disabled', () => {
    const t = computeAuthoritativeTotals({
      items: [line(120, 1, 0.2)],
      vatEnabled: false,
    });
    expect(t.vat).toBe(0);
    expect(t.net).toBe(120);
    expect(t.totalDue).toBe(120);
  });

  it('applies service charge before discount', () => {
    const t = computeAuthoritativeTotals({
      items: [line(100, 1)],
      serviceCharge: { enabled: true, mode: 'PERCENT', value: 10 },
      serviceChargeApplied: true,
      discountType: 'PERCENT',
      discountValue: 10,
    });
    expect(t.baseTotal).toBe(100);
    expect(t.serviceChargeAmount).toBe(10);
    expect(t.totalBefore).toBe(110);
    // 10% of 110, not of 100.
    expect(t.discountAmount).toBe(11);
    expect(t.totalDue).toBe(99);
  });

  it('never returns a negative total', () => {
    const t = computeAuthoritativeTotals({
      items: [line(10, 1)],
      discountType: 'AMOUNT',
      discountValue: 999,
    });
    expect(t.totalDue).toBe(0);
  });

  it('ignores voided lines', () => {
    const t = computeAuthoritativeTotals({
      items: [line(10, 1), { ...line(90, 1), voided: true }],
    });
    expect(t.baseTotal).toBe(10);
  });

  it('produces a clean total for the classic float-drift basket', () => {
    // 3 × 9.99 = 29.969999999999999 in IEEE-754.
    const t = computeAuthoritativeTotals({
      items: [line(9.99, 3)],
      serviceCharge: { enabled: true, mode: 'PERCENT', value: 10 },
      serviceChargeApplied: true,
      discountType: 'PERCENT',
      discountValue: 15,
    });
    expect(t.baseTotal).toBe(29.97);
    expect(t.serviceChargeAmount).toBe(3);
    expect(t.totalBefore).toBe(32.97);
    expect(t.discountAmount).toBe(4.95);
    expect(t.totalDue).toBe(28.02);
    expect(Number.isInteger(t.totalDue * 100)).toBe(true);
  });
});

describe('validatePaymentTotals', () => {
  const options = {
    vatEnabled: true,
    defaultVatRate: 0.2,
    serviceCharge: null,
  };

  it('accepts an honest client', () => {
    const items = [line(10, 2)];
    const v = validatePaymentTotals(
      items,
      { totalAfter: 20, discountType: 'NONE' },
      options,
    );
    expect(v.ok).toBe(true);
    expect(v.mismatch).toBeNull();
    expect(v.computed.totalDue).toBe(20);
  });

  it('tolerates sub-cent rounding drift', () => {
    const v = validatePaymentTotals(
      [line(9.99, 3)],
      { totalAfter: 29.969999999999999 },
      options,
    );
    expect(v.ok).toBe(true);
  });

  it('flags an understated total', () => {
    const v = validatePaymentTotals([line(100, 1)], { totalAfter: 1 }, options);
    expect(v.ok).toBe(false);
    expect(v.computed.totalDue).toBe(100);
    expect(v.claimedTotal).toBe(1);
    expect(v.delta).toBe(-99);
    expect(v.mismatch).toContain('total 1.00 vs 100.00');
  });

  it('flags a fabricated discount', () => {
    const v = validatePaymentTotals(
      [line(100, 1)],
      { totalAfter: 40, discountType: 'NONE', discountAmount: 60 },
      options,
    );
    expect(v.ok).toBe(false);
    expect(v.computed.discountAmount).toBe(0);
    expect(v.mismatch).toContain('discount');
  });

  it('recomputes service charge from host settings, not the claim', () => {
    const v = validatePaymentTotals(
      [line(100, 1)],
      { totalAfter: 150, serviceChargeApplied: true, serviceChargeAmount: 50 },
      {
        ...options,
        serviceCharge: { enabled: true, mode: 'PERCENT', value: 10 },
      },
    );
    expect(v.ok).toBe(false);
    expect(v.computed.serviceChargeAmount).toBe(10);
    expect(v.computed.totalDue).toBe(110);
    expect(v.mismatch).toContain('service');
  });

  it('passes through when the client sent no total', () => {
    const v = validatePaymentTotals([line(10, 1)], {}, options);
    expect(v.ok).toBe(true);
    expect(v.claimedTotal).toBeNull();
    expect(v.computed.totalDue).toBe(10);
  });

  it('treats a missing meta as no claim', () => {
    const v = validatePaymentTotals([line(10, 1)], null, options);
    expect(v.ok).toBe(true);
    expect(v.computed.totalDue).toBe(10);
  });
});

describe('applyAuthoritativeTotals', () => {
  const options = {
    vatEnabled: true,
    defaultVatRate: 0.2,
    serviceCharge: null,
  };

  it('replaces claimed figures with computed ones', () => {
    const items = [line(100, 1)];
    const meta = { kind: 'PAYMENT', totalAfter: 5, baseTotal: 5 };
    const next = applyAuthoritativeTotals(
      meta,
      validatePaymentTotals(items, meta, options),
    );
    expect(next.totalAfter).toBe(100);
    expect(next.baseTotal).toBe(100);
  });

  it('preserves the claim for audit when it diverged', () => {
    const items = [line(100, 1)];
    const meta: Record<string, any> = { totalAfter: 5 };
    const next = applyAuthoritativeTotals(
      meta,
      validatePaymentTotals(items, meta, options),
    );
    expect(next.totalsMismatch).toBeTruthy();
    expect(next.totalsMismatch.claimedTotal).toBe(5);
    expect(next.totalsMismatch.computedTotal).toBe(100);
    expect(next.totalsMismatch.delta).toBe(-95);
  });

  it('adds no mismatch marker when the client agreed', () => {
    const items = [line(100, 1)];
    const meta: Record<string, any> = { totalAfter: 100 };
    const next = applyAuthoritativeTotals(
      meta,
      validatePaymentTotals(items, meta, options),
    );
    expect(next.totalsMismatch).toBeUndefined();
  });

  it('keeps unrelated meta fields intact', () => {
    const items = [line(10, 1)];
    const meta = { kind: 'PAYMENT', method: 'CASH', userId: 7, totalAfter: 10 };
    const next = applyAuthoritativeTotals(
      meta,
      validatePaymentTotals(items, meta, options),
    );
    expect(next.kind).toBe('PAYMENT');
    expect(next.method).toBe('CASH');
    expect(next.userId).toBe(7);
  });
});
