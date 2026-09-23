import { beforeEach, describe, expect, it, vi } from 'vitest';

const orderFindMany = vi.fn();
const userFindUnique = vi.fn();
const readSettings = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    user: { findUnique: (...a: any[]) => userFindUnique(...a) },
    order: { findMany: (...a: any[]) => orderFindMany(...a) },
    dayShift: { update: vi.fn() },
  },
}));

vi.mock('./core', () => ({
  coreServices: { readSettings: (...a: any[]) => readSettings(...a) },
}));

vi.mock('./printDispatcher', () => ({
  dispatchTicket: vi.fn(),
  pickActiveReceiptProfile: vi.fn(),
}));

import { computeShiftPaidTotals } from './shiftSummary';

describe('computeShiftPaidTotals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockResolvedValue({ displayName: 'Ada' });
    readSettings.mockResolvedValue({ fiscal: { enabled: true } });
  });

  it('sums every paid Order in the shift with no row cap', async () => {
    orderFindMany.mockResolvedValue([
      {
        id: 1,
        userId: 7,
        area: 'Sallon',
        tableLabel: '12',
        total: 1200,
        closedAt: new Date('2026-09-05T12:00:00Z'),
        subtotal: 1000,
        vatAmount: 200,
        payments: [{ method: 'CASH', amount: 1200, metaJson: {} }],
      },
      {
        id: 2,
        userId: 7,
        area: 'Sallon',
        tableLabel: '8',
        total: 600,
        closedAt: new Date('2026-09-05T13:00:00Z'),
        subtotal: 500,
        vatAmount: 100,
        payments: [{ method: 'CARD', amount: 600, metaJson: {} }],
      },
    ]);
    const summary = await computeShiftPaidTotals({
      userId: 7,
      openedAt: new Date('2026-09-05T10:00:00Z'),
      closedAt: new Date('2026-09-05T22:00:00Z'),
    });
    expect(orderFindMany.mock.calls[0][0].take).toBeUndefined();
    expect(summary.orders).toBe(2);
    expect(summary.revenueNet).toBe(1500);
    expect(summary.revenueVat).toBe(300);
    expect(summary.revenueGross).toBe(1800);
    expect(summary.byMethod).toEqual([
      { method: 'CASH', amount: 1200 },
      { method: 'CARD', amount: 600 },
    ]);
  });

  it('drops reprint duplicate Orders from the shift total', async () => {
    const closedAt = new Date('2026-09-05T12:00:00Z');
    orderFindMany.mockResolvedValue([
      {
        id: 1,
        userId: 7,
        area: 'Sallon',
        tableLabel: '12',
        total: 1200,
        closedAt,
        subtotal: 1000,
        vatAmount: 200,
        payments: [
          {
            method: 'CASH',
            amount: 1200,
            metaJson: { kind: 'PAYMENT', reprint: true },
          },
        ],
      },
      {
        id: 2,
        userId: 7,
        area: 'Sallon',
        tableLabel: '12',
        total: 1200,
        closedAt,
        subtotal: 1000,
        vatAmount: 200,
        payments: [
          { method: 'CASH', amount: 1200, metaJson: { kind: 'PAYMENT' } },
        ],
      },
    ]);
    const summary = await computeShiftPaidTotals({
      userId: 7,
      openedAt: new Date('2026-09-05T10:00:00Z'),
      closedAt: new Date('2026-09-05T22:00:00Z'),
    });
    expect(summary.orders).toBe(1);
    expect(summary.revenueGross).toBe(1200);
  });
});
