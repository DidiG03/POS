import { describe, expect, it } from 'vitest';
import {
  buildReportPrintPayload,
  receiptLocationTitle,
  receiptStaffLine,
  reportTicketPrintItems,
} from './reportsReceipt';

const labels: Record<string, string> = {
  'reports.receiptTable': 'Table {{label}}',
  'reports.receiptSale': 'Sale',
  'common.waiterWithName': 'Waiter: {{name}}',
  'common.cashierWithName': 'Cashier: {{name}}',
  'common.waiter': 'Waiter',
  'common.cashier': 'Cashier',
};

function t(key: string, options?: Record<string, unknown>): string {
  let out = labels[key] ?? key;
  for (const [k, v] of Object.entries(options || {})) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

describe('reportsReceipt', () => {
  it('builds a receipt reprint payload for an active sitting', () => {
    const payload = buildReportPrintPayload(
      {
        kind: 'ACTIVE',
        area: 'Salla',
        tableLabel: 'T7',
        covers: 2,
        note: 'no onion',
        vatEnabled: true,
        total: 300,
        items: [
          { name: 'Patate', qty: 1, unitPrice: 300, station: 'KITCHEN' },
          { name: 'Voided', qty: 1, unitPrice: 100, voided: true },
        ],
      },
      { userId: 3, userName: 'Didi' },
    );
    expect(payload?.area).toBe('Salla');
    expect(payload?.tableLabel).toBe('T7');
    expect(payload?.items).toHaveLength(1);
    expect(payload?.meta?.kind).toBe('RECEIPT');
    expect(payload?.meta?.hidePrices).toBe(false);
    expect(payload?.userName).toBe('Didi');
  });

  it('builds a payment reprint for a paid sale', () => {
    const payload = buildReportPrintPayload(
      {
        kind: 'PAID',
        area: 'Salla',
        tableLabel: 'T1',
        paymentMethod: 'CASH',
        paidAt: '2026-09-21T12:00:00.000Z',
        total: 500,
        items: [{ name: 'Pizza', qty: 1, unitPrice: 500 }],
      },
      { userId: 1 },
    );
    expect(payload?.meta?.kind).toBe('PAYMENT');
    expect(payload?.meta?.method).toBe('CASH');
    expect(reportTicketPrintItems({ items: payload?.items })).toHaveLength(1);
  });

  it('returns null when there is nothing live to print', () => {
    expect(
      buildReportPrintPayload(
        { kind: 'ACTIVE', area: 'Salla', tableLabel: 'T8', items: [] },
        {},
      ),
    ).toBeNull();
  });

  it('names restaurant tickets by area and table', () => {
    expect(
      receiptLocationTitle(t, true, { area: 'Garden', tableLabel: '12' }),
    ).toBe('Garden • Table 12');
  });

  it('uses the till label on store, not Table', () => {
    expect(
      receiptLocationTitle(t, false, {
        area: 'Store',
        tableLabel: 'Till 3',
      }),
    ).toBe('Till 3');
  });

  it('falls back to Sale when a store row has no till label', () => {
    expect(receiptLocationTitle(t, false, { area: 'Store' })).toBe('Sale');
  });

  it('labels staff as cashier on store and waiter in restaurant', () => {
    expect(receiptStaffLine(t, true, 'Ana')).toBe('Waiter: Ana');
    expect(receiptStaffLine(t, false, 'Ana')).toBe('Cashier: Ana');
    expect(receiptStaffLine(t, false, null)).toBe('Cashier: —');
  });
});
