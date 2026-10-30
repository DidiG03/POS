/**
 * QA round 5, #1: an order sent while the table's payment was still being
 * filed (~1 s) brought the paid items back as unpaid, and they were charged
 * again.
 *
 * The real table lock, Send, payment settle, paid-line marking and kitchen
 * slip run here against one in-memory till: bill rows, table occupancy and
 * stock. The payment does what both payment routes do, in order, under the
 * table lock: check the table, file (slowly), record the sale, settle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  stock: new Map<string, number>(),
  /** Open tables: key → openedAt (ms). */
  open: new Map<string, number>(),
  /** Last open/close per table, on the till's clock (ms). */
  intent: new Map<string, number>(),
  sales: [] as Array<{ total: number; items: any[] }>,
  clock: 0,
}));

const tkey = (area: string, label: string) => `${area}:${label}`;
/** The till's clock; strictly increasing so open/close order is exact. */
const now = () => (h.clock = Math.max(h.clock + 1, Date.now()));
const sessionKeyOf = (area: string, label: string) => {
  const at = h.open.get(tkey(area, label));
  return at ? `${area}\u001f${label}\u001f${at}` : null;
};

vi.mock('@db/client', () => ({
  prisma: {
    ticketLog: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          h.rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.idempotencyKey?.in) {
          return h.rows.filter((r) =>
            where.idempotencyKey.in.includes(r.idempotencyKey),
          );
        }
        return h.rows
          .filter(
            (r) => r.area === where?.area && r.tableLabel === where?.tableLabel,
          )
          .slice()
          .reverse();
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: any) => ({
        id: where.id,
        role: 'WAITER',
      })),
    },
    menuItem: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('./linePricing', () => ({
  repriceLinesFromMenu: vi.fn(async () => null),
}));
vi.mock('./floorTables', () => ({
  checkFloorTable: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./license', () => ({ storePlanBlocksTables: () => false }));
vi.mock('./tableOccupancy', () => ({
  isTableOccupied: vi.fn(async (a: string, l: string) =>
    h.open.has(tkey(a, l)),
  ),
  setTableOccupied: vi.fn(
    async (a: string, l: string, open: boolean, _c?: unknown, o?: any) => {
      const k = tkey(a, l);
      if (open && !h.open.has(k)) h.open.set(k, now());
      if (!open) h.open.delete(k);
      h.intent.set(k, Number(o?.intentAt) || now());
      return true;
    },
  ),
  occupancyIntentIsStale: vi.fn(
    async (a: string, l: string, at: number) =>
      (h.intent.get(tkey(a, l)) ?? 0) > Number(at),
  ),
  countOccupiedTables: vi.fn(async () => h.open.size),
  listOccupiedTables: vi.fn(async () => []),
}));
vi.mock('./tableOpen', async () => {
  const { coreServices } = await import('./core');
  return {
    ensureOccupiedForTicketWrite: vi.fn(async (a: string, l: string) => {
      if (!h.open.has(tkey(a, l))) await coreServices.setTableOpen(a, l, true);
    }),
    applyTableOpenState: vi.fn(async (a: string, l: string, open: boolean) =>
      coreServices.setTableOpen(a, l, open),
    ),
  };
});
vi.mock('./tableSession', () => {
  const latest = (a: string, l: string) => {
    const key = sessionKeyOf(a, l);
    if (!key) return null;
    const row = [...h.rows]
      .reverse()
      .find((r) => r.area === a && r.tableLabel === l && r.sessionKey === key);
    return row ? { ...row } : null;
  };
  return {
    findLatestTicketLogForCurrentSession: vi.fn(async (a: string, l: string) =>
      latest(a, l),
    ),
    getCurrentSessionOwnerId: vi.fn(
      async (a: string, l: string) => latest(a, l)?.userId ?? null,
    ),
    getCurrentTableSessionKey: vi.fn(async (a: string, l: string) =>
      sessionKeyOf(a, l),
    ),
  };
});
vi.mock('./ticketLogWrite', async () => {
  const { withLineIds } = await import('@shared/ticketLineIds');
  return {
    writeTicketSnapshot: vi.fn(async (input: any) => {
      if (
        input.idempotencyKey &&
        h.rows.some((r) => r.idempotencyKey === input.idempotencyKey)
      ) {
        return 'duplicate';
      }
      for (const l of input.stockConsumeLines ?? []) {
        h.stock.set(l.sku, (h.stock.get(l.sku) ?? 0) - Number(l.qty));
      }
      const id = h.rows.length + 1;
      h.rows.push({
        id,
        userId: input.userId,
        area: input.area,
        tableLabel: input.tableLabel,
        covers: input.covers,
        itemsJson: withLineIds(input.items, { seed: id }),
        note: input.note,
        idempotencyKey: input.idempotencyKey,
        sessionKey: input.sessionKey,
        createdAt: new Date(now()),
      });
      return 'written';
    }),
  };
});

import { recordTicketSend } from './ticketSend';
import { settleTableAfterPayment, withPaymentLock } from './paymentSettle';
import { checkOrderSlip } from './orderSlip';
import { coreServices } from './core';

const T = { area: 'Salla', tableLabel: 'Q2' };
const espresso = { sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 1.6 };
const cappuccino = { sku: 'CAP', name: 'Cappuccino', qty: 1, unitPrice: 2.35 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The current sitting's bill (empty when the table is closed). */
function bill(): any[] {
  const key = sessionKeyOf(T.area, T.tableLabel);
  const row = [...h.rows].reverse().find((r) => r.sessionKey === key);
  return key && row ? row.itemsJson : [];
}
const unpaidTotal = () =>
  bill()
    .filter((l) => !l.voided && !l.paid)
    .reduce((s, l) => s + l.qty * l.unitPrice, 0);

/**
 * One payment, as both payment routes run it: under the table lock, check
 * the table, file with easyPos (slow), record the sale, settle the table.
 */
async function pay(items: any[], opts: { closeTable: boolean; key: string }) {
  return withPaymentLock(T.area, T.tableLabel, async () => {
    if (!(await coreServices.isTableOpen(T.area, T.tableLabel))) {
      return { ok: false as const, code: 'TABLE_ALREADY_PAID' };
    }
    await sleep(60); // easyPos filing
    h.sales.push({
      total: items.reduce((s, l) => s + l.qty * l.unitPrice, 0),
      items,
    });
    await settleTableAfterPayment({
      ...T,
      closeTable: opts.closeTable,
      items,
      userId: 7,
      paymentKey: opts.key,
    });
    return { ok: true as const };
  });
}

async function send(input: {
  key?: string;
  items: any[];
  added?: any[];
  capturedAt?: number;
}) {
  return recordTicketSend({
    userId: 7,
    ...T,
    covers: 2,
    note: null,
    idempotencyKey: input.key ?? null,
    items: input.items,
    addedItems: input.added ?? null,
    capturedAt: input.capturedAt ?? null,
  }) as Promise<any>;
}

async function slipPrints(sendKey: string) {
  const slip: any = await checkOrderSlip({
    ...T,
    meta: { kind: 'ORDER', sendKey },
  });
  return slip.kind === 'print' ? slip.items : [];
}

beforeEach(async () => {
  h.rows = [];
  h.sales = [];
  h.open.clear();
  h.intent.clear();
  h.stock = new Map([
    ['ESP', 10],
    ['CAP', 10],
  ]);
  // Espresso ordered and on the bill.
  const first = await send({
    key: 'k-esp',
    items: [{ ...espresso, sendKey: 'k-esp' }],
    added: [{ ...espresso, sendKey: 'k-esp' }],
  });
  expect(first.written).toBe(true);
});

describe('a Send that arrives while the table is being paid', () => {
  it('cannot put the paid Espresso back: the bill and the paid total hold', async () => {
    const paidLine = bill()[0];
    // Pay the Espresso and, at the same moment, send a Cappuccino from a
    // phone whose copy of the bill still shows the Espresso unpaid.
    const [paid, sent] = await Promise.all([
      pay([{ ...espresso, lineId: paidLine.lineId }], {
        closeTable: true,
        key: 'pay-1',
      }),
      (async () => {
        await sleep(5); // the payment holds the lock now
        return send({
          key: 'k-cap',
          items: [paidLine, { ...cappuccino, sendKey: 'k-cap' }],
          added: [{ ...cappuccino, sendKey: 'k-cap' }],
          capturedAt: Date.now(),
        });
      })(),
    ]);
    expect(paid.ok).toBe(true);
    expect(h.sales.map((s) => s.total)).toEqual([1.6]);
    // Refused, not written to the closed sitting or a new one with the
    // Espresso on it; the waiter opens the table and sends again.
    expect(sent).toMatchObject({ ok: false, code: 'TABLE_CLOSED' });
    expect(h.open.has(`${T.area}:${T.tableLabel}`)).toBe(false);
    expect(h.stock.get('CAP')).toBe(10);

    // Sent again (same phone, same stale copy of the paid bill).
    const again = await send({
      key: 'k-cap-2',
      items: [paidLine, { ...cappuccino, sendKey: 'k-cap-2' }],
      added: [{ ...cappuccino, sendKey: 'k-cap-2' }],
      capturedAt: now() + 5,
    });
    expect(again.written).toBe(true);
    // QA: the new bill was 3.95 (Espresso + Cappuccino).
    expect(bill().map((l) => l.name)).toEqual(['Cappuccino']);
    expect(unpaidTotal()).toBeCloseTo(2.35);
    expect(h.sales.map((s) => s.total)).toEqual([1.6]);
    // Each slip prints once, with only its own Send's line.
    expect((await slipPrints('k-cap-2')).map((l: any) => l.name)).toEqual([
      'Cappuccino',
    ]);
    expect(await slipPrints('k-cap')).toEqual([]);
    expect(await slipPrints('k-esp')).toEqual([]);
    expect(h.stock.get('ESP')).toBe(9);
    expect(h.stock.get('CAP')).toBe(9);
  });

  it('a Send without a capture time (scripts, older phones) is refused the same way', async () => {
    const paidLine = bill()[0];
    const [, sent] = await Promise.all([
      pay([{ ...espresso, lineId: paidLine.lineId }], {
        closeTable: true,
        key: 'pay-1',
      }),
      (async () => {
        await sleep(5);
        // Keyless, the bill as the script read it, plus the new order.
        return send({ items: [paidLine, cappuccino] });
      })(),
    ]);
    expect(sent).toMatchObject({ ok: false, code: 'TABLE_CLOSED' });
    expect(h.rows.filter((r) => r.sessionKey !== h.rows[0].sessionKey)).toEqual(
      [],
    );
    // Its retry opens a new sitting with the Cappuccino only.
    const again = await send({ items: [paidLine, cappuccino] });
    expect(again.written).toBe(true);
    expect(bill().map((l) => l.name)).toEqual(['Cappuccino']);
  });

  it('lines of the paid sitting stay out even after its Send rows are compacted', async () => {
    const paidLine = bill()[0];
    await pay([{ ...espresso, lineId: paidLine.lineId }], {
      closeTable: true,
      key: 'pay-1',
    });
    // Compaction removed the row that the Espresso's Send key points to;
    // only the sitting's last bill (with the line on it) is left.
    h.rows[0].idempotencyKey = 'compacted-away';
    const r = await send({
      key: 'k-cap',
      items: [paidLine, { ...cappuccino, sendKey: 'k-cap' }],
      added: [{ ...cappuccino, sendKey: 'k-cap' }],
      capturedAt: now() + 5,
    });
    expect(r.written).toBe(true);
    expect(bill().map((l) => l.name)).toEqual(['Cappuccino']);
  });
});

describe('a Send that arrives while one seat is being paid (table stays open)', () => {
  it('the paid Espresso stays paid and the new bill holds only the Cappuccino unpaid', async () => {
    const paidLine = bill()[0];
    const [paid, sent] = await Promise.all([
      pay([{ ...espresso, lineId: paidLine.lineId }], {
        closeTable: false,
        key: 'pay-seat',
      }),
      (async () => {
        await sleep(5);
        return send({
          key: 'k-cap',
          items: [paidLine, { ...cappuccino, sendKey: 'k-cap' }],
          added: [{ ...cappuccino, sendKey: 'k-cap' }],
          capturedAt: Date.now(),
        });
      })(),
    ]);
    expect(paid.ok).toBe(true);
    expect(sent.written).toBe(true);
    expect(bill().map((l) => [l.name, l.paid === true])).toEqual([
      ['Espresso', true],
      ['Cappuccino', false],
    ]);
    expect(unpaidTotal()).toBeCloseTo(2.35);
    expect(h.sales.map((s) => s.total)).toEqual([1.6]);

    // The paying phone's own follow-up copy of the bill changes nothing,
    // and neither does a phone that still shows the Espresso unpaid.
    await send({ items: bill().map((l) => ({ ...l, paid: true })) });
    await send({
      key: 'k-water',
      items: [
        { ...paidLine, paid: false },
        { ...cappuccino, sendKey: 'k-cap' },
      ],
      added: [],
    });
    expect(bill().find((l) => l.name === 'Espresso').paid).toBe(true);
    expect(unpaidTotal()).toBeCloseTo(2.35);
    expect((await slipPrints('k-cap')).map((l: any) => l.name)).toEqual([
      'Cappuccino',
    ]);
    expect(h.stock.get('CAP')).toBe(9);
  });

  it('a seat payment from an older device without line ids still flags the line', async () => {
    await pay([{ ...espresso }], { closeTable: false, key: 'pay-old' });
    expect(bill()[0].paid).toBe(true);
    // The same payment again (a retry) writes nothing new.
    const rows = h.rows.length;
    await pay([{ ...espresso }], { closeTable: false, key: 'pay-old' });
    expect(h.rows.length).toBe(rows);
  });
});
