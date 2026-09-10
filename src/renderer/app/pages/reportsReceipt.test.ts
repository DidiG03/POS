import { describe, expect, it } from 'vitest';
import { receiptLocationTitle, receiptStaffLine } from './reportsReceipt';

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
