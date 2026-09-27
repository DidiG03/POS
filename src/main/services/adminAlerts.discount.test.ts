import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./core', () => ({ coreServices: {}, withTableLock: vi.fn() }));
vi.mock('./tableOpen', () => ({ applyTableOpenState: vi.fn() }));

import { paymentDiscountAlertMessage } from './adminAlerts';

const base = {
  area: 'Hall',
  tableLabel: '4',
  meta: {
    kind: 'PAYMENT',
    userId: 7,
    discountAmount: 2.5,
    discountType: 'PERCENT',
    discountValue: 10,
    totalBefore: 25,
    totalAfter: 22.5,
    method: 'CASH',
    discountReason: 'staff',
  },
};

describe('paymentDiscountAlertMessage', () => {
  it('names the discount, the table, and the missing approval', () => {
    expect(paymentDiscountAlertMessage(base)).toBe(
      'Discount applied (10%) on Hall Table 4: -2.50 (total 25.00 → 22.50) · method CASH · reason: staff · NO MANAGER APPROVAL',
    );
  });

  it('names the manager who approved', () => {
    const msg = paymentDiscountAlertMessage({
      ...base,
      meta: { ...base.meta, managerApprovedByName: 'Ana' },
    });
    expect(msg).toContain('approved by: Ana');
    expect(msg).not.toContain('NO MANAGER APPROVAL');
  });

  it('skips a reprint of a sale that was already recorded', () => {
    expect(
      paymentDiscountAlertMessage({
        ...base,
        meta: { ...base.meta, reprint: true },
      }),
    ).toBeNull();
  });

  it('skips a payment with no discount', () => {
    expect(
      paymentDiscountAlertMessage({
        ...base,
        meta: { ...base.meta, discountAmount: 0 },
      }),
    ).toBeNull();
  });

  it('skips a kitchen send', () => {
    expect(
      paymentDiscountAlertMessage({
        ...base,
        meta: { ...base.meta, kind: 'KITCHEN' },
      }),
    ).toBeNull();
  });
});
