/**
 * The payload both payment paths hand to the receipt, the ledger and
 * fiskalizimi: lines priced from the menu, totals recomputed from them,
 * and admins told whenever the client's version was different.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { menu, notifications } = vi.hoisted(() => ({
  menu: [
    { sku: 'ESP', name: 'Espresso', price: 100, vatRate: 0.2 },
    { sku: 'STK', name: 'Steak', price: 1500, vatRate: 0.2 },
  ],
  notifications: [] as Array<{ userId: number; message: string }>,
}));

vi.mock('@db/client', () => ({
  prisma: {
    menuItem: {
      findMany: vi.fn(async () => menu),
    },
    syncState: { findUnique: vi.fn(async () => null) },
    user: { findMany: vi.fn(async () => [{ id: 99 }]) },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        notifications.push({ userId: data.userId, message: data.message });
        return data;
      }),
    },
  },
}));

vi.mock('./tableSession', () => ({
  getTableSessionStartedAt: vi.fn(async () => new Date(Date.now() - 60_000)),
}));

import { enforceAuthoritativePaymentTotals } from './paymentTotals';

const settings = { defaultVatRate: 0.2 };

function payment(items: any[], meta: Record<string, any> = {}) {
  return {
    area: 'Salla',
    tableLabel: '5',
    userName: 'Ana',
    items,
    meta: { kind: 'PAYMENT', userId: 7, ...meta },
  };
}

beforeEach(() => {
  notifications.length = 0;
});

describe('enforceAuthoritativePaymentTotals', () => {
  it('passes an honest payment through without an alert', async () => {
    const r = await enforceAuthoritativePaymentTotals(
      payment(
        [
          {
            sku: 'ESP',
            name: 'Espresso',
            qty: 2,
            unitPrice: 100,
            vatRate: 0.2,
          },
        ],
        { totalAfter: 200 },
      ),
      settings,
      'lan',
    );
    expect(r.mismatch).toBeNull();
    expect(r.payload.meta.totalAfter).toBe(200);
    expect(r.payload.meta).not.toHaveProperty('linePriceCheck');
    expect(notifications).toHaveLength(0);
  });

  it('charges and files the menu price when a phone under-prices a line', async () => {
    // The phone agrees with itself: 150 lek steak, total 150.
    const r = await enforceAuthoritativePaymentTotals(
      payment(
        [{ sku: 'STK', name: 'Steak', qty: 1, unitPrice: 150, vatRate: 0.2 }],
        { totalAfter: 150, baseTotal: 150 },
      ),
      settings,
      'lan',
    );
    expect(r.payload.items[0].unitPrice).toBe(1500);
    expect(r.payload.meta.totalAfter).toBe(1500);
    expect(r.payload.meta.linePriceCheck.issues).toHaveLength(1);
    expect(r.mismatch).toContain('Steak price 150.00 → 1500.00');
    expect(notifications.map((n) => n.userId).sort()).toEqual([7, 99]);
    expect(notifications[0].message).toContain(
      'Payment check on Salla Table 5',
    );
  });

  it('never reprices a reprint of a past sale', async () => {
    const items = [
      { sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 80, vatRate: 0.2 },
    ];
    const r = await enforceAuthoritativePaymentTotals(
      payment(items, { totalAfter: 80, reprint: true }),
      settings,
      'ipc',
    );
    expect(r.payload.items).toEqual(items);
    expect(r.payload.meta.totalAfter).toBe(80);
    expect(notifications).toHaveLength(0);
  });

  it('takes the payment on the client lines but says so when the menu is unreadable', async () => {
    const { prisma } = await import('@db/client');
    vi.mocked(prisma.menuItem.findMany).mockRejectedValueOnce(
      new Error('database is locked'),
    );
    const r = await enforceAuthoritativePaymentTotals(
      payment(
        [
          {
            sku: 'ESP',
            name: 'Espresso',
            qty: 1,
            unitPrice: 100,
            vatRate: 0.2,
          },
        ],
        { totalAfter: 100 },
      ),
      settings,
      'ipc',
    );
    expect(r.payload.meta.totalAfter).toBe(100);
    expect(r.mismatch).toContain('could not be checked against the menu');
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('leaves kitchen tickets untouched', async () => {
    const ticket = {
      area: 'Salla',
      tableLabel: '5',
      items: [{ sku: 'STK', name: 'Steak', qty: 1, unitPrice: 1 }],
      meta: { kind: 'ORDER' },
    };
    const r = await enforceAuthoritativePaymentTotals(ticket, settings, 'lan');
    expect(r.payload).toBe(ticket);
  });
});
