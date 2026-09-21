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
  matchOrdersToTicketRows,
  paidSalesNotOnTickets,
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
