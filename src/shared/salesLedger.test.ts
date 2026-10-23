import { describe, expect, it } from 'vitest';
import {
  cashChangeDue,
  isPaymentPayload,
  ledgerLinesFromPayload,
  normalizePaymentMethod,
  orderTypeFromArea,
  parsePaidAt,
  saleFiguresFromPayload,
} from './salesLedger';

const pizza = {
  name: 'Pizza',
  sku: 'P1',
  qty: 2,
  unitPrice: 600,
  vatRate: 0.2,
};

describe('isPaymentPayload', () => {
  it('accepts PAYMENT kind', () => {
    expect(isPaymentPayload({ meta: { kind: 'PAYMENT' } })).toBe(true);
    expect(isPaymentPayload({ meta: { kind: 'payment' } })).toBe(true);
  });

  it('rejects kitchen slips', () => {
    expect(isPaymentPayload({ meta: { kind: 'ORDER' } })).toBe(false);
    expect(isPaymentPayload({})).toBe(false);
  });
});

describe('normalizePaymentMethod', () => {
  it('keeps cash and card', () => {
    expect(normalizePaymentMethod('cash')).toBe('CASH');
    expect(normalizePaymentMethod('CARD')).toBe('CARD');
  });

  it('maps unknown methods to MIXED', () => {
    expect(normalizePaymentMethod('GIFT_CARD')).toBe('MIXED');
    expect(normalizePaymentMethod('')).toBe('MIXED');
  });
});

describe('orderTypeFromArea', () => {
  it('treats the store counter as takeaway', () => {
    expect(orderTypeFromArea('Store')).toBe('TAKEAWAY');
    expect(orderTypeFromArea('Sallon')).toBe('DINE_IN');
  });
});

describe('saleFiguresFromPayload', () => {
  it('uses host totalAfter when present', () => {
    const figs = saleFiguresFromPayload(
      {
        items: [pizza],
        meta: {
          kind: 'PAYMENT',
          method: 'CASH',
          totalAfter: 1140,
          discountAmount: 60,
          serviceChargeAmount: 0,
        },
      },
      { fiscal: { enabled: true }, defaultVatRate: 0.2 },
    );
    expect(figs.method).toBe('CASH');
    expect(figs.total).toBe(1140);
    expect(figs.discountAmount).toBe(60);
    expect(figs.vatEnabled).toBe(true);
    // VAT on the 1140 charged, as the fiscal invoice files it.
    expect(figs.subtotal).toBe(950);
    expect(figs.vat).toBe(190);
  });

  it('adds service charge VAT to the bands it was shared across', () => {
    const figs = saleFiguresFromPayload(
      {
        items: [
          { name: 'Wine', qty: 1, unitPrice: 120, vatRate: 0.2 },
          { name: 'Room', qty: 1, unitPrice: 106, vatRate: 0.06 },
        ],
        meta: { kind: 'PAYMENT', totalAfter: 248.6, serviceChargeAmount: 22.6 },
      },
      { fiscal: { enabled: true }, defaultVatRate: 0.2 },
    );
    expect(figs.vat).toBe(28.6);
    expect(figs.subtotal).toBe(220);
    expect(figs.subtotal + figs.vat).toBeCloseTo(figs.total, 2);
  });

  it('turns VAT off when fiskalizimi is disabled even if meta says otherwise', () => {
    const figs = saleFiguresFromPayload(
      {
        items: [pizza],
        meta: { kind: 'PAYMENT', vatEnabled: true },
      },
      { fiscal: { enabled: false } },
    );
    expect(figs.vatEnabled).toBe(false);
    expect(figs.total).toBe(1200);
    expect(figs.vat).toBe(0);
    expect(figs.subtotal).toBe(1200);
  });

  it('falls back to line math when totalAfter is missing', () => {
    const figs = saleFiguresFromPayload(
      {
        items: [pizza],
        meta: { kind: 'PAYMENT' },
      },
      { fiscal: { enabled: false } },
    );
    expect(figs.total).toBe(1200);
    expect(figs.vat).toBe(0);
    expect(figs.subtotal).toBe(1200);
  });
});

describe('ledgerLinesFromPayload', () => {
  it('drops voided and empty qty lines', () => {
    const lines = ledgerLinesFromPayload({
      items: [
        pizza,
        { ...pizza, voided: true },
        { name: 'Skip', qty: 0, unitPrice: 1 },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.name).toBe('Pizza');
  });
});

describe('parsePaidAt / cashChangeDue', () => {
  it('parses ISO paidAt', () => {
    const d = parsePaidAt('2026-09-05T20:00:00.000Z');
    expect(d.toISOString()).toBe('2026-09-05T20:00:00.000Z');
  });

  it('computes cash change', () => {
    expect(cashChangeDue(2000, 1140)).toBe(860);
    expect(cashChangeDue(500, 1140)).toBe(0);
  });
});
