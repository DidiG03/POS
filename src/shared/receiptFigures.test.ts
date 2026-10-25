import { describe, expect, it } from 'vitest';
import { formatMoneyPlain, receiptFigures } from './receiptFigures';
import { computeAuthoritativeTotals } from './pricing';
import { saleFiguresFromPayload } from './salesLedger';

const vat = { vatEnabled: true, defaultVatRate: 0.2 };

describe('receiptFigures', () => {
  it('prints the VAT in what was charged, not before the discount', () => {
    const items = [{ name: 'Fileto', qty: 1, unitPrice: 1200, vatRate: 0.2 }];
    const t = computeAuthoritativeTotals({
      items,
      ...vat,
      discountType: 'PERCENT',
      discountValue: 10,
    });
    const r = receiptFigures(
      items,
      { totalAfter: t.totalDue, discountAmount: t.discountAmount },
      vat,
    );
    expect(r.total).toBe(1080);
    expect(r.vat).toBe(180); // 1080 / 1.2 × 0.2, not 200 on the undiscounted 1200
    expect(r.net + r.vat).toBe(r.total);
  });

  it('agrees with the sales ledger to the cent', () => {
    const items = [
      { name: 'Kafe', qty: 3, unitPrice: 150, vatRate: 0.2 },
      { name: 'Dhome', qty: 1, unitPrice: 4000, vatRate: 0.06 },
      { name: 'Peshk', qty: 0.941, unitPrice: 1959, vatRate: 0.2 },
    ];
    const sc = { enabled: true, mode: 'PERCENT' as const, value: 10 };
    const t = computeAuthoritativeTotals({
      items,
      ...vat,
      serviceCharge: sc,
      serviceChargeApplied: true,
      discountType: 'AMOUNT',
      discountValue: 250,
    });
    const meta = {
      kind: 'PAYMENT',
      totalAfter: t.totalDue,
      serviceChargeAmount: t.serviceChargeAmount,
      discountAmount: t.discountAmount,
      vatEnabled: true,
    };
    const r = receiptFigures(items, meta, vat);
    const ledger = saleFiguresFromPayload(
      { items, meta },
      { defaultVatRate: 0.2, fiscal: { enabled: true } },
    );
    expect(r.goods).toBe(t.baseTotal);
    expect([r.total, r.vat, r.net]).toEqual([
      ledger.total,
      ledger.vat,
      ledger.subtotal,
    ]);
  });

  it('leaves struck lines off', () => {
    const r = receiptFigures(
      [
        { name: 'A', qty: 1, unitPrice: 500, vatRate: 0.2 },
        { name: 'B', qty: 1, unitPrice: 900, vatRate: 0.2, voided: true },
      ],
      {},
      vat,
    );
    expect(r.goods).toBe(500);
    expect(r.total).toBe(500);
  });
});

describe('formatMoneyPlain', () => {
  it('prints whole amounts plain and cents only when present', () => {
    expect(formatMoneyPlain(1200)).toBe('1200');
    expect(formatMoneyPlain(1111.5)).toBe('1111.50');
    expect(formatMoneyPlain(5.97)).toBe('5.97');
    expect(formatMoneyPlain(1234567, ',')).toBe('1,234,567');
    expect(formatMoneyPlain(-2.5)).toBe('-2.50');
    expect(formatMoneyPlain(10.075)).toBe('10.08');
  });
});
