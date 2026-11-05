/**
 * QA v0.2.103 H3: a Send that lands right after a payment brought the paid
 * item back on a new bill, so it was charged twice.
 *
 * Real SQLite, real Send (`recordTicketSend`) and the real payment steps the
 * till runs under the table's payment lock (stale-bill check, sale write,
 * table close). The two race each other in both orders, with the phone's
 * stale copy of the paid bill carried along, keyed and unkeyed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.hoisted(() => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'pay-vs-send-'),
  );
  // One connection: the migrator's BEGIN and COMMIT must share it (under a
  // busy parallel run the pool split them: "no transaction is active").
  process.env.DATABASE_URL = `file:${dir}/pos.db?connection_limit=1`;
  (globalThis as any).__payVsSendDir = dir;
});

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle() {} },
  Notification: class {},
  safeStorage: {},
  default: {},
}));
vi.mock('./realtime', () => ({
  broadcastTableStatusChanged: () => undefined,
  broadcastTicketsChanged: () => undefined,
  broadcastReservationsChanged: () => undefined,
}));

import { prisma } from '@db/client';
import { runPendingMigrations } from './migrator';
import { recordTicketSend } from './ticketSend';
import {
  settleTableAfterPayment,
  tableIsOpenForPayment,
  withPaymentLock,
} from './paymentSettle';
import { findStaleBillPayment } from './staleBill';
import { writeSettledSale } from './salesLedger';
import { findLatestTicketLogForCurrentSession } from './tableSession';
import { coreServices } from './core';
import { listFiscalClaimsForTableSince } from './fiscal/claims';

const AREA = 'Salla';
let TABLE = 'T7';
let tableNo = 0;
let waiter = 0;
let cashier = 0;

beforeAll(async () => {
  const res = await runPendingMigrations(
    path.join(__dirname, '..', '..', '..', 'prisma', 'migrations'),
  );
  expect(res.failed, JSON.stringify(res.failed)).toBeNull();
  const cat = await prisma.category.create({ data: { name: 'Salads' } });
  for (const [sku, name, price] of [
    ['ULL', 'Sallatë Ullishtja', 600],
    ['RRA', 'Sallate rradhiqe', 500],
  ] as const) {
    await prisma.menuItem.create({
      data: { sku, name, price, vatRate: 0.2, categoryId: cat.id } as any,
    });
  }
  waiter = (
    await prisma.user.create({
      data: { displayName: 'DidiG03', role: 'WAITER', pinHash: 'x' },
    })
  ).id;
  cashier = (
    await prisma.user.create({
      data: { displayName: 'Cashier', role: 'CASHIER', pinHash: 'x' },
    })
  ).id;
  // Building the schema from all migrations takes a while on a busy runner.
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
  fs.rmSync((globalThis as any).__payVsSendDir, {
    recursive: true,
    force: true,
  });
});

let n = 0;
const key = (p: string) => `${p}-${++n}`;

beforeEach(() => {
  // A fresh table per case: no earlier sittings to confuse the result.
  TABLE = `T${++tableNo}`;
});

function line(sku: 'ULL' | 'RRA', sendKey: string, extra: object = {}) {
  return {
    sku,
    name: sku === 'ULL' ? 'Sallatë Ullishtja' : 'Sallate rradhiqe',
    qty: 1,
    unitPrice: sku === 'ULL' ? 600 : 500,
    vatRate: 0.2,
    fired: true,
    sendKey,
    ...extra,
  };
}

async function send(items: object[], sendKey: string, addedItems?: object[]) {
  return recordTicketSend({
    userId: waiter,
    area: AREA,
    tableLabel: TABLE,
    covers: 1,
    items,
    note: null,
    idempotencyKey: sendKey,
    capturedAt: Date.now(),
    addedItems: addedItems ?? null,
  });
}

/** What the till does for a PAYMENT under the table's payment lock. */
async function pay(items: object[], payKey: string) {
  return withPaymentLock(AREA, TABLE, async () => {
    if (!(await tableIsOpenForPayment(AREA, TABLE))) return 'already-paid';
    const stale = await findStaleBillPayment({
      area: AREA,
      tableLabel: TABLE,
      items: items as any,
    });
    if (stale) return 'stale-bill';
    await writeSettledSale(prisma as any, {
      payload: {
        area: AREA,
        tableLabel: TABLE,
        items,
        meta: { kind: 'PAYMENT', method: 'CASH', userId: cashier },
      },
      idempotencyKey: payKey,
    });
    await settleTableAfterPayment({
      area: AREA,
      tableLabel: TABLE,
      closeTable: true,
      items,
      userId: cashier,
      paymentKey: payKey,
    });
    return 'paid';
  });
}

async function currentBill(): Promise<any[]> {
  const row = await findLatestTicketLogForCurrentSession(AREA, TABLE);
  return row ? ((row as any).itemsJson as any[]) : [];
}

async function billOnServer(): Promise<any[]> {
  // What a phone hydrates: the bill as the till stored it (keys, line ids).
  return currentBill();
}

describe('pay vs send on one table (QA H3)', () => {
  for (const order of ['pay first', 'send first'] as const) {
    for (const keyed of [true, false]) {
      it(`never puts a paid line on a new bill (${order}, stale lines ${keyed ? 'keyed' : 'unkeyed'})`, async () => {
        const s1 = key('send');
        expect((await send([line('ULL', s1)], s1)).ok).toBe(true);
        const paidBill = await billOnServer();
        expect(paidBill).toHaveLength(1);

        // The phone still shows the paid bill and adds a salad.
        const s2 = key('send');
        const stale = paidBill.map((l) =>
          keyed ? l : { ...l, sendKey: undefined, lineId: `phone-${n}` },
        );
        const added = [line('RRA', s2)];
        const sendLate = () => send([...stale, ...added], s2, added);
        const payNow = () => pay(paidBill, key('pay'));

        const [payResult, sendResult] =
          order === 'pay first'
            ? await Promise.all([payNow(), sendLate()])
            : await Promise.all([sendLate().then((r) => r), payNow()]).then(
                ([s, p]) => [p, s] as const,
              );

        const bill = await currentBill();
        const skus = bill.filter((l) => !l.voided).map((l) => l.sku);
        if (payResult === 'paid') {
          // The salad paid for is never on the new bill.
          expect(skus).not.toContain('ULL');
          if (sendResult.ok && (sendResult as any).written) {
            expect(skus).toEqual(['RRA']);
          }
        } else {
          // The Send got in first: the bill changed, so that payment is
          // refused as stale and nothing is charged twice either.
          expect(payResult).toBe('stale-bill');
          expect(skus.sort()).toEqual(['RRA', 'ULL']);
        }
        // One sale for the paid salad at most.
        const sales = await prisma.order.count({
          where: { area: AREA, tableLabel: TABLE, status: 'PAID' } as any,
        });
        expect(sales).toBeLessThanOrEqual(n);
      });
    }
  }

  it('a Send after the payment starts a new bill with only its own lines', async () => {
    const s1 = key('send');
    await send([line('ULL', s1)], s1);
    const paidBill = await billOnServer();
    expect(await pay(paidBill, key('pay'))).toBe('paid');

    // The phone opened the table again itself (covers dialog) and sends
    // its stale copy without the keys it was hydrated with.
    await coreServices.setTableOpen(AREA, TABLE, true);
    const s2 = key('send');
    const added = [line('RRA', s2)];
    const r = await send(
      [{ ...paidBill[0], sendKey: undefined, lineId: 'phone-x' }, ...added],
      s2,
      added,
    );
    expect(r.ok).toBe(true);
    expect((await currentBill()).map((l) => l.sku)).toEqual(['RRA']);
  });
});

describe("one table's fiscal claims, on real SQLite (QA v0.2.104 #16)", () => {
  it('reads only that table, in SQL, and only since the given time', async () => {
    const at = new Date().toISOString();
    const claim = (area: string, tableLabel: string, state = 'REGISTERED') => ({
      state,
      attemptId: 'a',
      attempts: 1,
      createdAt: at,
      updatedAt: at,
      context: { area, tableLabel },
    });
    await prisma.syncState.create({
      data: {
        key: 'fiscal:claim:pv-1',
        valueJson: claim('Salla', 'Q1') as any,
      },
    });
    await prisma.syncState.create({
      data: {
        key: 'fiscal:claim:pv-2',
        valueJson: claim('Salla', 'Q2') as any,
      },
    });
    await prisma.syncState.create({
      data: {
        key: 'fiscal:claim:pv-3',
        valueJson: claim('Tarraca', 'Q1') as any,
      },
    });
    // Not a claim, though it looks like one.
    await prisma.syncState.create({
      data: { key: 'fiscal:other', valueJson: claim('Salla', 'Q1') as any },
    });
    const since = new Date(Date.now() - 60_000);
    // The SQL path, not the old scan of every claim.
    const scan = vi.spyOn(prisma.syncState, 'findMany');
    const rows = await listFiscalClaimsForTableSince({
      area: 'Salla',
      tableLabel: 'Q1',
      since,
    });
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['pv-1']);
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
    // Updated before `since`: left out.
    expect(
      await listFiscalClaimsForTableSince({
        area: 'Salla',
        tableLabel: 'Q1',
        since: new Date(Date.now() + 60_000),
      }),
    ).toEqual([]);
  });
});

describe('table history lookups use an index, not a sort (audit 2026-11, H1)', () => {
  it('latest bill, covers and paid orders read newest-id first without sorting', async () => {
    const queries = [
      `SELECT * FROM "TicketLog" WHERE "area" = ? AND "tableLabel" = ? ORDER BY "id" DESC LIMIT 40`,
      `SELECT * FROM "Covers" WHERE "area" = ? AND "label" = ? ORDER BY "id" DESC LIMIT 20`,
      `SELECT * FROM "Order" WHERE "area" = ? AND "tableLabel" = ? AND "status" = 'PAID' ORDER BY "id" DESC LIMIT 20`,
    ];
    for (const sql of queries) {
      const plan = (await prisma.$queryRawUnsafe(
        `EXPLAIN QUERY PLAN ${sql}`,
        'Salla',
        'T1',
      )) as Array<{ detail?: string }>;
      const text = plan.map((r) => String(r.detail ?? '')).join(' | ');
      expect(text, sql).not.toMatch(/TEMP B-TREE/);
      expect(text, sql).toMatch(/USING (COVERING )?INDEX/);
    }
  });
});
