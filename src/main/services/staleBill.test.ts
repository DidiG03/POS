import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  since: vi.fn(async (): Promise<Date | null> => null),
  latest: vi.fn(async (): Promise<any> => null),
  orders: vi.fn(async (_args: unknown): Promise<any[]> => []),
}));

vi.mock('@db/client', () => ({
  prisma: { order: { findMany: h.orders } },
}));
vi.mock('./tableSession', () => ({
  getTableSessionStartedAt: h.since,
  findLatestTicketLogSince: h.latest,
}));

import { findStaleBillPayment, uncoveredBillLines } from './staleBill';

const fries = { sku: 'FRIES', name: 'Patate', qty: 1, unitPrice: 300 };
const cola = { sku: 'COLA', name: 'Coca Cola', qty: 2, unitPrice: 200 };

describe('uncoveredBillLines', () => {
  it('flags items added after the paying screen loaded', () => {
    expect(
      uncoveredBillLines({
        bill: [fries, cola],
        paidEarlier: [],
        paying: [fries],
      }),
    ).toEqual([{ name: 'Coca Cola', qty: 2 }]);
  });

  it('accepts a payment that covers the bill, or more than it', () => {
    expect(
      uncoveredBillLines({ bill: [fries], paidEarlier: [], paying: [fries] }),
    ).toEqual([]);
    expect(
      uncoveredBillLines({
        bill: [fries],
        paidEarlier: [],
        paying: [fries, cola],
      }),
    ).toEqual([]);
  });

  it('ignores voided and seat-paid lines, and counts earlier payments', () => {
    expect(
      uncoveredBillLines({
        bill: [
          fries,
          { ...cola, voided: true },
          { sku: 'BEER', name: 'Birre', qty: 1, paid: true },
          { sku: 'WATER', name: 'Uje', qty: 1 },
        ],
        // Seat 1 paid the water, but its "paid" snapshot never reached the till.
        paidEarlier: [{ sku: 'WATER', name: 'Uje', qty: 1 }],
        paying: [fries],
      }),
    ).toEqual([]);
  });

  it('compares quantities, matching by name when there is no sku', () => {
    expect(
      uncoveredBillLines({
        bill: [{ name: 'Kafe', qty: 3 }],
        paidEarlier: [],
        paying: [{ name: 'kafe ', qty: 2 }],
      }),
    ).toEqual([{ name: 'Kafe', qty: 1 }]);
  });
});

describe('findStaleBillPayment', () => {
  beforeEach(() => {
    h.since.mockReset().mockResolvedValue(new Date('2026-10-11T18:00:00Z'));
    h.latest.mockReset().mockResolvedValue({ itemsJson: [fries, cola] });
    h.orders.mockReset().mockResolvedValue([]);
  });

  it('refuses a stale bill with a permanent BILL_CHANGED', async () => {
    const r = await findStaleBillPayment({
      area: 'Salla',
      tableLabel: '20',
      items: [fries],
    });
    expect(r).toMatchObject({
      ok: false,
      code: 'BILL_CHANGED',
      permanent: true,
    });
    expect(r?.error).toContain('2 x Coca Cola');
  });

  it('counts this sitting’s earlier payments, not previous sittings', async () => {
    h.orders.mockResolvedValue([
      // Previous sitting: must not excuse the cola.
      {
        closedAt: new Date('2026-10-11T17:00:00Z'),
        items: [{ sku: 'COLA', name: 'Coca Cola', qty: '2' }],
      },
    ]);
    expect(
      await findStaleBillPayment({
        area: 'Salla',
        tableLabel: '20',
        items: [fries],
      }),
    ).not.toBeNull();

    h.orders.mockResolvedValue([
      {
        closedAt: new Date('2026-10-11T18:30:00Z'),
        items: [{ sku: 'COLA', name: 'Coca Cola', qty: '2' }],
      },
    ]);
    expect(
      await findStaleBillPayment({
        area: 'Salla',
        tableLabel: '20',
        items: [fries],
      }),
    ).toBeNull();
  });

  it('skips counter sales and tables without a sitting or bill', async () => {
    expect(
      await findStaleBillPayment({ area: 'Store', tableLabel: '1', items: [] }),
    ).toBeNull();
    h.since.mockResolvedValueOnce(null);
    expect(
      await findStaleBillPayment({
        area: 'Salla',
        tableLabel: '20',
        items: [],
      }),
    ).toBeNull();
    h.latest.mockResolvedValueOnce(null);
    expect(
      await findStaleBillPayment({
        area: 'Salla',
        tableLabel: '20',
        items: [],
      }),
    ).toBeNull();
  });
});
