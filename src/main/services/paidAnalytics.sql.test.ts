/**
 * The sales loader and the void counter filter inside SQLite. Run the real
 * SQL against a real SQLite, once with the plain ledger's INTEGER ms dates
 * and once with the encrypted ledger's adapter TEXT dates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client, type InValue } from '@libsql/client';

const db = vi.hoisted(() => ({ client: null as any }));

vi.mock('@db/client', () => ({
  prisma: {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
      (await db.client.execute({ sql, args: args as InValue[] })).rows.map(
        (r: any) => ({ ...r }),
      ),
    ticketLog: {
      findMany: async ({ where }: any) => {
        const ids: number[] = where.id.in;
        const rows = (
          await db.client.execute({
            sql: `SELECT "itemsJson" FROM "TicketLog" WHERE "id" IN (${ids.map(() => '?').join(',')})`,
            args: ids,
          })
        ).rows;
        return rows.map((r: any) => ({ itemsJson: JSON.parse(r.itemsJson) }));
      },
    },
    user: { findMany: async () => [] },
    dayShift: { findMany: async () => [] },
  },
}));
vi.mock('./core', () => ({
  coreServices: { readSettings: vi.fn().mockResolvedValue({}) },
}));

import {
  countVoidedTickets,
  getAdminReview,
  fetchPaidSales,
  fetchWindows,
} from './paidAnalytics';
import { adapterDateTimeText } from '@db/datetimeText';

const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

type DateMode = 'integer' | 'text';
const at = (iso: string, mode: DateMode) =>
  mode === 'integer' ? Date.parse(iso) : adapterDateTimeText(new Date(iso));

async function ledger(mode: DateMode) {
  const client = createClient({ url: ':memory:' });
  clients.push(client);
  db.client = client;
  await client.executeMultiple(`
    CREATE TABLE "Order" ("id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL, "userId" INTEGER,
      "area" TEXT NOT NULL DEFAULT '', "tableLabel" TEXT NOT NULL DEFAULT '', "covers" INTEGER,
      "closedAt" DATETIME, "createdAt" DATETIME NOT NULL, "subtotal" DECIMAL NOT NULL DEFAULT 0,
      "vatAmount" DECIMAL NOT NULL DEFAULT 0, "total" DECIMAL NOT NULL DEFAULT 0);
    CREATE INDEX "Order_status_closedAt_idx" ON "Order"("status", "closedAt");
    CREATE TABLE "OrderItem" ("id" INTEGER PRIMARY KEY, "orderId" INTEGER NOT NULL, "name" TEXT NOT NULL,
      "qty" DECIMAL NOT NULL, "unitPrice" DECIMAL NOT NULL, "categoryName" TEXT,
      "sortOrder" INTEGER NOT NULL DEFAULT 0, "voidedAt" DATETIME);
    CREATE TABLE "Payment" ("id" INTEGER PRIMARY KEY, "orderId" INTEGER NOT NULL, "method" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL, "fiscalNslf" TEXT, "fiscalNivf" TEXT, "metaJson" JSONB NOT NULL);
    CREATE TABLE "TicketLog" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "area" TEXT NOT NULL,
      "tableLabel" TEXT NOT NULL, "itemsJson" JSONB NOT NULL, "note" TEXT,
      "createdAt" DATETIME NOT NULL, "sessionKey" TEXT);
  `);
  const run = (sql: string, args: InValue[]) => client.execute({ sql, args });
  return {
    async order(o: {
      id: number;
      closedAt: string;
      total: number;
      status?: string;
      userId?: number;
      table?: string;
      covers?: number;
      meta?: unknown;
      method?: string;
      nslf?: string | null;
      noPayment?: boolean;
      items?: Array<[string, number, number, number, boolean?]>;
    }) {
      const t = at(o.closedAt, mode);
      await run(
        `INSERT INTO "Order" VALUES (?, ?, ?, 'Salla', ?, ?, ?, ?, ?, 0, ?)`,
        [
          o.id,
          o.status ?? 'PAID',
          o.userId ?? 2,
          o.table ?? 'T1',
          o.covers ?? 2,
          t,
          t,
          o.total,
          o.total,
        ],
      );
      if (!o.noPayment) {
        await run(`INSERT INTO "Payment" VALUES (?, ?, ?, ?, ?, NULL, ?)`, [
          o.id * 10,
          o.id,
          o.method ?? 'CASH',
          t,
          o.nslf ?? null,
          typeof o.meta === 'string'
            ? o.meta
            : JSON.stringify(o.meta ?? { kind: 'PAYMENT', closeTable: true }),
        ]);
      }
      for (const [i, [name, qty, price, sort, voided]] of (
        o.items ?? []
      ).entries()) {
        await run(
          `INSERT INTO "OrderItem" VALUES (?, ?, ?, ?, ?, 'Food', ?, ?)`,
          [o.id * 100 + i, o.id, name, qty, price, sort, voided ? t : null],
        );
      }
    },
    async ticket(t: {
      id: number;
      at: string;
      items: unknown;
      key?: string | null;
      note?: string | null;
      table?: string;
      userId?: number;
    }) {
      await run(
        `INSERT INTO "TicketLog" VALUES (?, ?, 'Salla', ?, ?, ?, ?, ?)`,
        [
          t.id,
          t.userId ?? 2,
          t.table ?? 'T1',
          typeof t.items === 'string' ? t.items : JSON.stringify(t.items),
          t.note ?? null,
          at(t.at, mode),
          t.key ?? null,
        ],
      );
    },
  };
}

const DAY = {
  from: new Date('2026-10-20T00:00:00.000Z'),
  to: new Date('2026-10-20T23:59:59.999Z'),
};

describe.each(['integer', 'text'] as const)(
  'fetchPaidSales (%s dates)',
  (mode) => {
    it('returns the sales in range with lines in order', async () => {
      const l = await ledger(mode);
      await l.order({
        id: 1,
        closedAt: '2026-10-19T23:59:59.999Z',
        total: 100,
      });
      await l.order({
        id: 2,
        closedAt: '2026-10-20T12:00:00.000Z',
        total: 1150.5,
        items: [
          ['Second', 1, 150.5, 2],
          ['First', 2, 500, 1],
          ['Voided', 1, 999, 3, true],
        ],
      });
      await l.order({
        id: 3,
        closedAt: '2026-10-20T23:59:59.999Z',
        total: 300,
      });
      await l.order({
        id: 4,
        closedAt: '2026-10-21T00:00:00.000Z',
        total: 400,
      });
      await l.order({
        id: 5,
        closedAt: '2026-10-20T13:00:00.000Z',
        total: 500,
        status: 'VOID',
      });

      const sales = await fetchPaidSales(DAY);
      expect(sales.map((s) => s.total)).toEqual([1150.5, 300]);
      expect(sales[0].closedAt.toISOString()).toBe('2026-10-20T12:00:00.000Z');
      expect(sales[0].items).toEqual([
        { name: 'First', qty: 2, unitPrice: 500, categoryName: 'Food' },
        { name: 'Second', qty: 1, unitPrice: 150.5, categoryName: 'Food' },
      ]);
    });

    it('drops reprints, collapses double writes and keeps closeTable', async () => {
      const l = await ledger(mode);
      await l.order({
        id: 1,
        closedAt: '2026-10-20T10:00:00.000Z',
        total: 100,
        meta: { kind: 'payment', reprint: true },
      });
      await l.order({
        id: 2,
        closedAt: '2026-10-20T11:00:00.000Z',
        total: 200,
      });
      await l.order({
        id: 3,
        closedAt: '2026-10-20T11:00:00.000Z',
        total: 200,
        nslf: 'NSLF',
        method: 'CARD',
      });
      await l.order({
        id: 4,
        closedAt: '2026-10-20T12:00:00.000Z',
        total: 300,
        meta: { kind: 'PAYMENT', closeTable: false },
      });
      await l.order({
        id: 5,
        closedAt: '2026-10-20T13:00:00.000Z',
        total: 400,
        noPayment: true,
      });
      await l.order({
        id: 6,
        closedAt: '2026-10-20T14:00:00.000Z',
        total: 500,
        meta: '{not json',
      });

      const sales = await fetchPaidSales(DAY);
      // The fiscalized copy of the double write wins.
      expect(
        sales.map((s) => [s.total, s.paymentMethod, s.closeTable]),
      ).toEqual([
        [200, 'CARD', true],
        [300, 'CASH', false],
        // No payment row: method unknown, as before.
        [400, 'MIXED', true],
        [500, 'CASH', true],
      ]);
    });

    it('filters by waiter', async () => {
      const l = await ledger(mode);
      await l.order({
        id: 1,
        closedAt: '2026-10-20T10:00:00.000Z',
        total: 100,
        userId: 2,
      });
      await l.order({
        id: 2,
        closedAt: '2026-10-20T11:00:00.000Z',
        total: 200,
        userId: 3,
      });
      const sales = await fetchPaidSales({ ...DAY, userId: 3 });
      expect(sales.map((s) => s.total)).toEqual([200]);
    });

    it('reads a long range in slices without losing or repeating a sale', async () => {
      const l = await ledger(mode);
      const from = new Date('2026-01-01T00:00:00.000Z');
      const to = new Date('2026-12-31T23:59:59.999Z');
      const windows = fetchWindows(from, to);
      expect(windows.length).toBeGreaterThan(20);
      // A sale exactly on every slice edge, plus one either side.
      let id = 1;
      for (const w of windows) {
        for (const ms of [w.from.getTime(), w.to.getTime()]) {
          await l.order({
            id: id++,
            closedAt: new Date(ms).toISOString(),
            total: id,
            table: `T${id}`,
          });
        }
      }
      const sales = await fetchPaidSales({ from, to });
      expect(sales).toHaveLength(windows.length * 2);
      expect(new Set(sales.map((s) => s.total)).size).toBe(windows.length * 2);
    });
  },
);

describe('fetchWindows', () => {
  it('tiles the range with no gap or overlap', () => {
    const from = new Date('2026-03-01T00:00:00.000Z');
    const to = new Date('2026-04-15T12:34:56.789Z');
    const w = fetchWindows(from, to);
    expect(w[0].from).toEqual(from);
    expect(w[w.length - 1].to).toEqual(to);
    for (let i = 1; i < w.length; i++) {
      expect(w[i].from.getTime()).toBe(w[i - 1].to.getTime() + 1);
    }
  });
});

describe.each(['integer', 'text'] as const)(
  'countVoidedTickets (%s dates)',
  (mode) => {
    const v = (n: number, voided = true) =>
      Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, voided }));

    it('counts sittings whose newest snapshot is fully voided', async () => {
      const l = await ledger(mode);
      const k = (s: string) => `Salla\u001f${s}\u001f2026-10-20`;
      // Live then voided: counts once.
      await l.ticket({
        id: 1,
        at: '2026-10-20T10:00:00.000Z',
        items: v(2, false),
        key: k('A'),
      });
      await l.ticket({
        id: 2,
        at: '2026-10-20T10:05:00.000Z',
        items: v(2),
        key: k('A'),
      });
      // Voided then a live line added: does not count.
      await l.ticket({
        id: 3,
        at: '2026-10-20T10:00:00.000Z',
        items: v(1),
        key: k('B'),
      });
      await l.ticket({
        id: 4,
        at: '2026-10-20T10:05:00.000Z',
        items: [...v(1), { sku: 'x' }],
        key: k('B'),
      });
      // Same timestamp: the later row wins.
      await l.ticket({
        id: 5,
        at: '2026-10-20T11:00:00.000Z',
        items: v(1, false),
        key: k('C'),
      });
      await l.ticket({
        id: 6,
        at: '2026-10-20T11:00:00.000Z',
        items: v(1),
        key: k('C'),
      });
      // Padded copy of a key groups with the trimmed one.
      await l.ticket({
        id: 7,
        at: '2026-10-20T12:00:00.000Z',
        items: v(1),
        key: `  ${k('D')}  `,
      });
      await l.ticket({
        id: 8,
        at: '2026-10-20T12:01:00.000Z',
        items: v(1, false),
        key: k('D'),
      });
      // Moved to another table: not a void here.
      await l.ticket({
        id: 9,
        at: '2026-10-20T13:00:00.000Z',
        items: v(1),
        key: k('E'),
        note: '[TRANSFER moved-out to T9]',
      });
      // Broken JSON and a non-object line do not crash or count.
      await l.ticket({
        id: 10,
        at: '2026-10-20T14:00:00.000Z',
        items: '{oops',
        key: k('F'),
      });
      await l.ticket({
        id: 11,
        at: '2026-10-20T14:00:00.000Z',
        items: ['x', { voided: true }],
        key: k('G'),
      });
      // Empty ticket does not count.
      await l.ticket({
        id: 12,
        at: '2026-10-20T14:00:00.000Z',
        items: [],
        key: k('H'),
      });
      // Out of range.
      await l.ticket({
        id: 13,
        at: '2026-10-21T00:00:00.000Z',
        items: v(1),
        key: k('I'),
      });

      expect(await countVoidedTickets(DAY.from, DAY.to)).toBe(2);
    });

    it('still counts legacy rows with no usable session key', async () => {
      const l = await ledger(mode);
      await l.ticket({
        id: 1,
        at: '2026-10-20T10:00:00.000Z',
        items: v(1),
        key: null,
        table: 'L1',
      });
      // Area-only leftover key cannot group; counted per table.
      await l.ticket({
        id: 2,
        at: '2026-10-20T10:00:00.000Z',
        items: v(1),
        key: 'Salla',
        table: 'L2',
      });
      await l.ticket({
        id: 3,
        at: '2026-10-20T10:00:00.000Z',
        items: v(1, false),
        key: '',
        table: 'L3',
      });
      expect(await countVoidedTickets(DAY.from, DAY.to)).toBe(2);
    });
  },
);

describe.each(['integer', 'text'] as const)(
  'Review credits the serving waiter (%s dates)',
  (mode) => {
    const line = [{ sku: 'a', name: 'Pizza', qty: 1, unitPrice: 500 }];
    const k = (t: string) => `Salla\u001f${t}\u001f2026-10-20`;

    it('follows the table, not the device that took payment', async () => {
      const l = await ledger(mode);
      // Waiter 7 served T1; the admin (1) took payment at the till.
      await l.ticket({
        id: 1,
        at: '2026-10-20T10:00:00.000Z',
        items: line,
        key: k('T1'),
        table: 'T1',
        userId: 7,
      });
      await l.order({
        id: 1,
        closedAt: '2026-10-20T11:00:00.000Z',
        total: 500,
        userId: 1,
        table: 'T1',
      });
      // Counter sale with no table sitting stays with whoever rang it up.
      await l.order({
        id: 2,
        closedAt: '2026-10-20T11:30:00.000Z',
        total: 200,
        userId: 3,
        table: 'Bar',
      });
      // T2 handed from 8 to 9; 8 still took the payment.
      await l.ticket({
        id: 2,
        at: '2026-10-20T12:00:00.000Z',
        items: line,
        key: k('T2'),
        table: 'T2',
        userId: 8,
        note: '[TRANSFER moved-out → Salla T2]',
      });
      await l.ticket({
        id: 3,
        at: '2026-10-20T12:10:00.000Z',
        items: line,
        key: k('T2'),
        table: 'T2',
        userId: 9,
        note: '[TRANSFER Ana → Ben]',
      });
      await l.order({
        id: 3,
        closedAt: '2026-10-20T13:00:00.000Z',
        total: 300,
        userId: 8,
        table: 'T2',
      });
      // T3: waiter 5's sitting was closed by a voided sale; a later payment
      // with no new sitting stays with the payer (6).
      await l.ticket({
        id: 4,
        at: '2026-10-20T14:00:00.000Z',
        items: line,
        key: k('T3'),
        table: 'T3',
        userId: 5,
      });
      await l.order({
        id: 4,
        closedAt: '2026-10-20T14:30:00.000Z',
        total: 400,
        userId: 5,
        table: 'T3',
        status: 'VOID',
      });
      await l.order({
        id: 5,
        closedAt: '2026-10-20T15:00:00.000Z',
        total: 600,
        userId: 6,
        table: 'T3',
      });

      const review = await getAdminReview({
        currentStartIso: DAY.from.toISOString(),
        currentEndIso: DAY.to.toISOString(),
        granularity: 'day',
      } as any);
      const byWaiter = Object.fromEntries(
        (review as any).waiters.map((w: any) => [
          w.userId,
          [w.orders, w.revenue],
        ]),
      );
      expect(byWaiter).toEqual({
        7: [1, 500],
        3: [1, 200],
        9: [1, 300],
        6: [1, 600],
      });
      expect((review as any).current.revenueGross).toBe(1600);
    });

    it('credits a table served before midnight and paid after it', async () => {
      const l = await ledger(mode);
      // Waiter 7 served T5 from 23:00; the till took payment at 00:30.
      await l.ticket({
        id: 1,
        at: '2026-10-19T23:00:00.000Z',
        items: line,
        key: k('T5'),
        table: 'T5',
        userId: 7,
      });
      await l.order({
        id: 1,
        closedAt: '2026-10-20T00:30:00.000Z',
        total: 500,
        userId: 1,
        table: 'T5',
      });
      // T6 was served and paid yesterday evening; a counter sale on that
      // label after midnight must not inherit the old, settled sitting.
      await l.ticket({
        id: 2,
        at: '2026-10-19T20:00:00.000Z',
        items: line,
        key: k('T6'),
        table: 'T6',
        userId: 4,
      });
      await l.order({
        id: 2,
        closedAt: '2026-10-19T21:00:00.000Z',
        total: 900,
        userId: 4,
        table: 'T6',
      });
      await l.order({
        id: 3,
        closedAt: '2026-10-20T00:10:00.000Z',
        total: 200,
        userId: 6,
        table: 'T6',
      });

      const review = await getAdminReview({
        currentStartIso: DAY.from.toISOString(),
        currentEndIso: DAY.to.toISOString(),
        granularity: 'day',
      } as any);
      const byWaiter = Object.fromEntries(
        (review as any).waiters.map((w: any) => [
          w.userId,
          [w.orders, w.revenue],
        ]),
      );
      expect(byWaiter).toEqual({ 7: [1, 500], 6: [1, 200] });
    });
  },
);
