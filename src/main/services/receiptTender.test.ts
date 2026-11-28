import { describe, expect, it, vi } from 'vitest';
vi.mock('@db/client', () => ({ prisma: {} }));
import { receiptCashRows } from '../print';

describe('receipt cash lines', () => {
  it('prints cash received and change when known', () => {
    expect(
      receiptCashRows({ cashTendered: 50, cashChange: 32.6 }, 'en'),
    ).toEqual([
      { label: 'Cash received', amount: 50 },
      { label: 'Change', amount: 32.6 },
    ]);
    expect(
      receiptCashRows({ cashTendered: 50, cashChange: 32.6 }, 'sq')[1].label,
    ).toBe('Kusuri');
    expect(receiptCashRows({}, 'en')).toEqual([]);
  });
});
