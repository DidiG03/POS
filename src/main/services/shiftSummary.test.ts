import { beforeEach, describe, expect, it, vi } from 'vitest';

const orderFindMany = vi.fn();
const userFindUnique = vi.fn();
const readSettings = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    user: { findUnique: (...a: any[]) => userFindUnique(...a) },
    order: { findMany: (...a: any[]) => orderFindMany(...a) },
    dayShift: { update: vi.fn(async () => ({})) },
  },
}));

vi.mock('./core', () => ({
  coreServices: { readSettings: (...a: any[]) => readSettings(...a) },
}));

vi.mock('./printDispatcher', () => ({
  dispatchTicket: vi.fn(),
  pickActiveReceiptProfile: vi.fn(),
}));

const notices: any[] = [];
vi.mock('./adminAlerts', () => ({
  notifyAdminsAndActor: async (n: any) => {
    notices.push(n);
  },
}));

import {
  computeShiftPaidTotals,
  finalizeShiftAfterClockOut,
} from './shiftSummary';

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

describe('finalizeShiftAfterClockOut — closed automatically', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notices.length = 0;
    userFindUnique.mockResolvedValue({ displayName: 'Ada' });
    orderFindMany.mockResolvedValue([
      {
        id: 1,
        userId: 7,
        area: 'Sallon',
        tableLabel: '12',
        total: 40,
        closedAt: new Date('2026-09-05T12:00:00Z'),
        subtotal: 40,
        vatAmount: 0,
        payments: [{ method: 'CASH', amount: 40, metaJson: {} }],
      },
    ]);
  });

  const run = () =>
    finalizeShiftAfterClockOut({
      shiftId: 3,
      userId: 7,
      openedAt: new Date('2026-09-05T10:00:00Z'),
      closedAt: new Date('2026-09-06T10:00:00Z'),
      cashCounted: null,
      autoClosed: true,
    });

  it('keeps a summary and says the cash was not counted', async () => {
    readSettings.mockResolvedValue({
      preferences: { cashCountAtClockOut: true },
    });
    const summary = await run();
    expect(summary.revenueGross).toBe(40);
    expect(summary.autoClosed).toBe(true);
    expect(summary.cashNotCounted).toBe(true);
    expect(summary.cashCount).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('not counted');
    expect(notices[0].message).toContain('40.00');
  });

  it('does not ask for a count the venue does not take', async () => {
    readSettings.mockResolvedValue({});
    const summary = await run();
    expect(summary.autoClosed).toBe(true);
    expect(summary.cashNotCounted).toBeUndefined();
    expect(notices).toEqual([]);
  });
});
