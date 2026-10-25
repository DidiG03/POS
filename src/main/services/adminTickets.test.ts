import { describe, expect, it, vi } from 'vitest';
import { latestRowPerSession } from '@shared/ticketRevenue';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./core', () => ({
  coreServices: {
    readSettings: async () => ({}),
    listOpenTables: async () => [],
  },
}));

import {
  adminTicketRevenueAmount,
  matchOrdersToTicketRows,
  paidSalesNotOnTickets,
  resolveAdminTicketStatus,
  staffSittings,
  unionTicketLogsById,
} from './adminTickets';

describe('unionTicketLogsById', () => {
  it('keeps rows the raw date query missed', () => {
    const raw = [{ id: 50, tableLabel: 'T15' }];
    const js = [
      { id: 50, tableLabel: 'T15' },
      { id: 40, tableLabel: 'T8' },
      { id: 30, tableLabel: 'T3' },
    ];
    expect(unionTicketLogsById(raw, js).map((r) => r.id)).toEqual([50, 40, 30]);
  });
});

describe('resolveAdminTicketStatus', () => {
  it('never marks an unmatched closed sitting as PAID', () => {
    expect(
      resolveAdminTicketStatus({
        isVoided: false,
        isTransferred: false,
        isPaid: false,
      }),
    ).toBe('ACTIVE');
  });

  it('marks a matched sale as PAID', () => {
    expect(
      resolveAdminTicketStatus({
        isVoided: false,
        isTransferred: false,
        isPaid: true,
      }),
    ).toBe('PAID');
  });
});

describe('adminTicketRevenueAmount', () => {
  it('prefers the settled Order total over kitchen line math', () => {
    expect(
      adminTicketRevenueAmount({
        settledTotal: 1140,
        liveItems: [{ name: 'Pizza', qty: 1, unitPrice: 1200, vatRate: 0.2 }],
        vatEnabled: true,
        defaultVatRate: 0.2,
      }),
    ).toBe(1140);
  });

  it('falls back to VAT-inclusive goods when no settled total', () => {
    expect(
      adminTicketRevenueAmount({
        settledTotal: null,
        liveItems: [{ name: 'Pizza', qty: 1, unitPrice: 1200, vatRate: 0.2 }],
        vatEnabled: true,
        defaultVatRate: 0.2,
      }),
    ).toBe(1200);
  });
});

describe('matchOrdersToTicketRows', () => {
  const t0 = Date.parse('2026-09-20T10:00:00.000Z');
  const t1 = Date.parse('2026-09-20T12:00:00.000Z');
  const t2 = Date.parse('2026-09-20T18:00:00.000Z');

  it('does not attach a later table’s payment to an earlier ticket', () => {
    const got = matchOrdersToTicketRows(
      [
        { id: 1, area: 'Salla', tableLabel: 'T15', createdAt: t0 },
        { id: 2, area: 'Salla', tableLabel: 'T8', createdAt: t1 },
      ],
      [
        { id: 90, area: 'Salla', tableLabel: 'T15', closedAt: t2 },
        { id: 91, area: 'Salla', tableLabel: 'T8', closedAt: t2 },
      ],
    );
    expect(got.orderIdByTicketId.get(1)).toBe(90);
    expect(got.orderIdByTicketId.get(2)).toBe(91);
    expect(got.usedOrderIds.size).toBe(2);
  });
});

describe('paidSalesNotOnTickets', () => {
  it('returns paid sittings that have no TicketLog row', () => {
    expect(
      paidSalesNotOnTickets(new Set([90]), [
        { orderId: 90, tableLabel: 'T15' },
        { orderId: 91, tableLabel: 'T3' },
        { orderId: 92, tableLabel: 'T11' },
      ]).map((s) => s.tableLabel),
    ).toEqual(['T3', 'T11']);
  });
});

describe('Daniel-style area-key collapse', () => {
  it('lists every paid table, not one ticket per room', () => {
    const t15 = Date.parse('2026-09-20T19:16:00.000Z');
    const t30 = Date.parse('2026-09-20T18:00:00.000Z');
    const t20 = Date.parse('2026-09-20T17:00:00.000Z');
    const t22 = Date.parse('2026-09-20T16:00:00.000Z');
    const t29 = Date.parse('2026-09-20T15:00:00.000Z');
    const t31 = Date.parse('2026-09-20T14:00:00.000Z');
    const t23 = Date.parse('2026-09-20T19:32:00.000Z');

    const logs = latestRowPerSession([
      {
        id: 1,
        sessionKey: 'Salla',
        area: 'Salla',
        tableLabel: 'T15',
        createdAt: t15,
        itemsJson: [{ name: 'Pizza', qty: 1, unitPrice: 10 }],
      },
      {
        id: 2,
        sessionKey: 'Veranda',
        area: 'Veranda',
        tableLabel: 'T23',
        createdAt: t23,
        itemsJson: [{ name: 'Beer', qty: 1, unitPrice: 3 }],
      },
    ]);
    const orders = [
      {
        id: 90,
        orderId: 90,
        area: 'Salla',
        tableLabel: 'T15',
        closedAt: t15 + 1,
      },
      {
        id: 91,
        orderId: 91,
        area: 'Veranda',
        tableLabel: 'T30',
        closedAt: t30,
      },
      {
        id: 92,
        orderId: 92,
        area: 'Veranda',
        tableLabel: 'T20',
        closedAt: t20,
      },
      {
        id: 93,
        orderId: 93,
        area: 'Veranda',
        tableLabel: 'T22',
        closedAt: t22,
      },
      {
        id: 94,
        orderId: 94,
        area: 'Veranda',
        tableLabel: 'T29',
        closedAt: t29,
      },
      {
        id: 95,
        orderId: 95,
        area: 'Veranda',
        tableLabel: 'T31',
        closedAt: t31,
      },
    ];
    const { usedOrderIds } = matchOrdersToTicketRows(logs, orders);
    const extra = paidSalesNotOnTickets(usedOrderIds, orders);
    const tables = [
      ...logs.map((r) => r.tableLabel),
      ...extra.map((r) => r.tableLabel),
    ].sort();
    expect(tables).toEqual(['T15', 'T20', 'T22', 'T23', 'T29', 'T30', 'T31']);
  });
});

describe('staffSittings', () => {
  const key = (t: string) => `Salla\u001f${t}\u001f2026-10-20T18:00:00.000Z`;
  const out = (to: string) => `[TRANSFER moved-out → Salla ${to}]`;
  const row = (
    id: number,
    userId: number,
    tableLabel: string,
    note: string | null = null,
  ) => ({
    id,
    userId,
    area: 'Salla',
    tableLabel,
    sessionKey: key(tableLabel),
    createdAt: new Date(1_000 * id),
    itemsJson: [{ sku: 'a', name: 'Pizza', qty: 1, unitPrice: 10 }],
    note,
  });

  it('keeps a moved table as one handed-off sitting on the source', () => {
    const { live, movedOut } = staffSittings([
      row(1, 7, 'T1', out('T5')),
      row(2, 7, 'T1', out('T5')),
      { ...row(3, 7, 'T5', '[TRANSFER from Salla T1 → Salla T5]') },
    ]);
    expect(live.map((r) => r.id)).toEqual([3]);
    expect(movedOut.map((r) => r.id)).toEqual([2]);
  });

  it('keeps the old owner on a same-table handoff', () => {
    // Owner change reuses the session key; the new owner's row is newest.
    const { live, movedOut } = staffSittings([
      row(1, 7, 'T1', out('T1')),
      row(2, 8, 'T1', '[TRANSFER Ana → Ben]'),
    ]);
    expect(live.map((r) => [r.id, r.userId])).toEqual([[2, 8]]);
    expect(movedOut.map((r) => [r.id, r.userId])).toEqual([[1, 7]]);
  });

  it('counts each waiter once when a ticket is passed on twice', () => {
    const { live, movedOut } = staffSittings([
      row(1, 7, 'T1', out('T1')),
      row(2, 8, 'T1', `${out('T1')}\n[TRANSFER Ana → Ben]`),
      row(3, 8, 'T1', out('T1')),
      row(4, 9, 'T1', '[TRANSFER Ben → Cara]'),
    ]);
    expect(live.map((r) => r.userId)).toEqual([9]);
    expect(movedOut.map((r) => [r.id, r.userId]).sort()).toEqual([
      [1, 7],
      [3, 8],
    ]);
  });
});

describe('matchOrdersToTicketRows pairing', () => {
  const at = (h: number) => Date.parse('2026-09-20T00:00:00.000Z') + h * 36e5;
  const sit = (id: number, h: number, table = 'T1') => ({
    id,
    area: 'Salla',
    tableLabel: table,
    createdAt: at(h),
  });
  const pay = (id: number, h: number, table = 'T1') => ({
    id,
    area: 'Salla',
    tableLabel: table,
    closedAt: at(h),
  });

  it('does not let an abandoned sitting take the next guest’s payment', () => {
    // 10:00 walkout (never paid); 19:00 next guests, paid 20:30.
    const got = matchOrdersToTicketRows(
      [sit(1, 10), sit(2, 19)],
      [pay(90, 20.5)],
    );
    expect([...got.orderIdByTicketId]).toEqual([[2, 90]]);
  });

  it('pairs back-to-back sittings with their own payments', () => {
    const got = matchOrdersToTicketRows(
      [sit(1, 10), sit(2, 12)],
      [pay(90, 11), pay(91, 13)],
    );
    expect(Object.fromEntries(got.orderIdByTicketId)).toEqual({ 1: 90, 2: 91 });
  });

  it('leaves a second payment on one sitting unmatched', () => {
    // Split bill: the first payment settles the sitting, the second is extra.
    const got = matchOrdersToTicketRows(
      [sit(1, 10)],
      [pay(90, 11), pay(91, 11.5)],
    );
    expect([...got.orderIdByTicketId]).toEqual([[1, 90]]);
    expect([...got.usedOrderIds]).toEqual([90]);
  });

  it('ignores a payment taken before any sitting on that table', () => {
    const got = matchOrdersToTicketRows([sit(1, 12)], [pay(90, 11)]);
    expect(got.orderIdByTicketId.size).toBe(0);
  });

  // Plain reference: each payment, in time order, takes the latest unused
  // sitting on its table at or before it.
  function reference(tickets: any[], orders: any[]) {
    const used = new Set<number>();
    const out = new Map<number, number>();
    for (const o of [...orders].sort((a, b) => a.closedAt - b.closedAt)) {
      const cands = tickets.filter(
        (t) =>
          t.tableLabel === o.tableLabel &&
          t.createdAt <= o.closedAt &&
          !used.has(t.id),
      );
      if (!cands.length || [...out.values()].includes(o.id)) continue;
      const best = cands.reduce((m, t) => (t.createdAt >= m.createdAt ? t : m));
      used.add(best.id);
      out.set(best.id, o.id);
    }
    return out;
  }

  it('matches a plain reference on random service days', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 300; round++) {
      const tables = ['T1', 'T2', 'T3'];
      const tickets = Array.from(
        { length: 1 + Math.floor(rnd() * 25) },
        (_, i) => ({
          id: i + 1,
          area: 'Salla',
          tableLabel: tables[Math.floor(rnd() * 3)],
          createdAt: (i * 7 + Math.floor(rnd() * 5)) * 1000,
        }),
      );
      const orders = Array.from({ length: Math.floor(rnd() * 25) }, (_, i) => ({
        id: 100 + i,
        area: 'Salla',
        tableLabel: tables[Math.floor(rnd() * 3)],
        closedAt: (i * 7 + Math.floor(rnd() * 9)) * 1000,
      }));
      const got = matchOrdersToTicketRows(tickets, orders).orderIdByTicketId;
      expect([...got.entries()].sort()).toEqual(
        [...reference(tickets, orders).entries()].sort(),
      );
    }
  });
});
