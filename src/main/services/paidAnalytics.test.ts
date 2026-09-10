import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./core', () => ({
  coreServices: { readSettings: vi.fn().mockResolvedValue({}) },
}));

import {
  fillTrendPoints,
  paidSaleFromOrderRow,
  saleClosesTable,
  summarizePaidSales,
  topSellingFromSales,
  type PaidSale,
} from './paidAnalytics';

function sale(partial: Partial<PaidSale> & { closedAt: Date }): PaidSale {
  return {
    userId: 7,
    area: 'Sallon',
    tableLabel: '12',
    covers: 4,
    subtotal: 1000,
    vatAmount: 200,
    total: 1200,
    closeTable: true,
    paymentMethod: 'CASH',
    items: [{ name: 'Pizza', qty: 2, unitPrice: 600, categoryName: 'Food' }],
    ...partial,
  };
}

const day = new Date('2026-09-05T20:00:00');

describe('saleClosesTable', () => {
  it('counts covers on a full-table pay', () => {
    expect(saleClosesTable({ kind: 'PAYMENT' })).toBe(true);
    expect(saleClosesTable({})).toBe(true);
  });

  it('skips covers on a partial seat pay', () => {
    expect(saleClosesTable({ kind: 'PAYMENT', closeTable: false })).toBe(false);
  });
});

describe('paidSaleFromOrderRow', () => {
  it('reads ledger columns and closeTable from payment meta', () => {
    const s = paidSaleFromOrderRow({
      closedAt: day,
      userId: 7,
      area: 'Sallon',
      tableLabel: '12',
      covers: 4,
      subtotal: '1000.00',
      vatAmount: '200.00',
      total: '1140.00',
      items: [{ name: 'Pizza', qty: '1.00', unitPrice: '1200.00' }],
      payments: [{ metaJson: { kind: 'PAYMENT', closeTable: false } }],
    });
    expect(s.total).toBe(1140);
    expect(s.closeTable).toBe(false);
    expect(s.items[0]?.qty).toBe(1);
  });

  it('reads CARD from the payment row, not from line math', () => {
    const s = paidSaleFromOrderRow({
      closedAt: day,
      total: '800.00',
      items: [],
      payments: [{ method: 'CARD', metaJson: {} }],
    });
    expect(s.paymentMethod).toBe('CARD');
    expect(s.total).toBe(800);
  });
});

describe('summarizePaidSales', () => {
  const start = new Date('2026-09-05T00:00:00');
  const end = new Date('2026-09-05T23:59:59.999');

  it('uses paid totals, not kitchen line math', () => {
    const out = summarizePaidSales(
      [
        sale({
          closedAt: day,
          subtotal: 1000,
          vatAmount: 200,
          total: 1140,
          items: [
            { name: 'Pizza', qty: 2, unitPrice: 600, categoryName: 'Food' },
          ],
        }),
      ],
      start,
      end,
      'day',
      0,
    );
    expect(out.summary.orders).toBe(1);
    expect(out.summary.revenueGross).toBe(1140);
    expect(out.summary.revenueNet).toBe(1000);
    expect(out.summary.revenueVat).toBe(200);
    expect(out.summary.items).toBe(2);
  });

  it('counts covers once on the closing seat payment', () => {
    const out = summarizePaidSales(
      [
        sale({
          closedAt: new Date('2026-09-05T20:00:00'),
          closeTable: false,
          total: 600,
          covers: 4,
          items: [
            { name: 'Beer', qty: 1, unitPrice: 600, categoryName: 'Drinks' },
          ],
        }),
        sale({
          closedAt: new Date('2026-09-05T20:10:00'),
          closeTable: true,
          total: 540,
          covers: 4,
          items: [
            { name: 'Pizza', qty: 1, unitPrice: 540, categoryName: 'Food' },
          ],
        }),
      ],
      start,
      end,
      'day',
      1,
    );
    expect(out.summary.orders).toBe(2);
    expect(out.summary.covers).toBe(4);
    expect(out.summary.revenueGross).toBe(1140);
    expect(out.summary.voidedTickets).toBe(1);
    expect(out.summary.avgSpendPerCover).toBe(285);
    expect(out.summary.avgTicket).toBe(570);
    const byMethod = Object.fromEntries(out.byMethod.map((m) => [m.method, m]));
    expect(byMethod.CASH?.orders).toBe(2);
    expect(byMethod.CASH?.revenue).toBe(1140);
    expect(byMethod.CARD?.revenue).toBe(0);
    expect(out.byMethod.reduce((n, m) => n + m.revenue, 0)).toBe(
      out.summary.revenueGross,
    );
    expect(out.byArea).toEqual([{ name: 'Sallon', orders: 2, revenue: 1140 }]);
    expect(out.ticketSizes.reduce((n, b) => n + b.orders, 0)).toBe(2);
    expect(out.ticketSizes.reduce((n, b) => n + b.revenue, 0)).toBe(1140);
    const cats = Object.fromEntries(out.byCategory.map((c) => [c.name, c]));
    expect(cats.Drinks?.qty).toBe(1);
    expect(cats.Drinks?.revenue).toBe(600);
    expect(cats.Food?.qty).toBe(1);
    expect(cats.Food?.revenue).toBe(540);
    expect(out.byCategory.reduce((n, c) => n + c.revenue, 0)).toBe(1140);
    const heat = out.heatmap.find(
      (c) => c.dayOfWeek === day.getDay() && c.hour === day.getHours(),
    );
    expect(heat?.orders).toBe(2);
    expect(heat?.revenue).toBe(1140);
  });

  it('splits cash and card by receipt total, not by cash tendered', () => {
    const out = summarizePaidSales(
      [
        sale({
          closedAt: day,
          paymentMethod: 'CASH',
          total: 1000,
          items: [
            { name: 'Pizza', qty: 1, unitPrice: 1000, categoryName: 'Food' },
          ],
        }),
        sale({
          closedAt: day,
          paymentMethod: 'CARD',
          total: 400,
          items: [
            { name: 'Beer', qty: 2, unitPrice: 200, categoryName: 'Drinks' },
          ],
        }),
      ],
      start,
      end,
      'day',
      0,
    );
    const byMethod = Object.fromEntries(out.byMethod.map((m) => [m.method, m]));
    expect(byMethod.CASH).toEqual({ method: 'CASH', orders: 1, revenue: 1000 });
    expect(byMethod.CARD).toEqual({ method: 'CARD', orders: 1, revenue: 400 });
    expect(byMethod.MIXED?.revenue).toBe(0);
    expect(out.summary.revenueGross).toBe(1400);
    expect(out.byMethod.reduce((n, m) => n + m.revenue, 0)).toBe(
      out.summary.revenueGross,
    );
  });

  it('does not force category mix to equal a discounted bill total', () => {
    const out = summarizePaidSales(
      [
        sale({
          closedAt: day,
          total: 900,
          subtotal: 900,
          vatAmount: 0,
          items: [
            { name: 'Pizza', qty: 1, unitPrice: 600, categoryName: 'Food' },
            { name: 'Beer', qty: 1, unitPrice: 400, categoryName: 'Drinks' },
          ],
        }),
      ],
      start,
      end,
      'day',
      0,
    );
    expect(out.summary.revenueGross).toBe(900);
    expect(out.byMethod.find((m) => m.method === 'CASH')?.revenue).toBe(900);
    expect(out.byCategory.reduce((n, c) => n + c.revenue, 0)).toBe(1000);
    expect(out.ticketSizes.reduce((n, b) => n + b.revenue, 0)).toBe(900);
  });
});

describe('topSellingFromSales / fillTrendPoints', () => {
  it('picks the item with the highest qty', () => {
    const best = topSellingFromSales([
      sale({
        closedAt: day,
        items: [
          { name: 'Pizza', qty: 2, unitPrice: 600, categoryName: 'Food' },
          { name: 'Beer', qty: 5, unitPrice: 200, categoryName: 'Drinks' },
        ],
      }),
    ]);
    expect(best?.name).toBe('Beer');
    expect(best?.qty).toBe(5);
  });

  it('buckets paid totals by time range', () => {
    const from = new Date('2026-09-05T00:00:00');
    const to = new Date('2026-09-05T23:59:59.999');
    const points = fillTrendPoints(
      [sale({ closedAt: day, total: 1200 })],
      [{ label: '09/05', from, to }],
    );
    expect(points[0]).toEqual({ label: '09/05', total: 1200, orders: 1 });
  });
});
