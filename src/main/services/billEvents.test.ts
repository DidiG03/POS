import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));

import {
  billEventLines,
  billEventLinesAmount,
  billEventsOfPayment,
  listBillEvents,
  recordBillEvent,
} from './billEvents';

function fakeDb(opts: { failCreates?: number } = {}) {
  const rows: any[] = [];
  let fails = opts.failCreates ?? 0;
  return {
    rows,
    billEvent: {
      create: vi.fn(async ({ data }: any) => {
        if (fails > 0) {
          fails -= 1;
          throw new Error('SQLITE_BUSY');
        }
        rows.push({ id: rows.length + 1, ...data });
      }),
      findMany: vi.fn(async (args: any) => {
        const w = args.where || {};
        return rows
          .filter(
            (r) =>
              (!w.kind || w.kind.in.includes(r.kind)) &&
              (!w.actorUserId || r.actorUserId === w.actorUserId) &&
              (!w.id || r.id < w.id.lt) &&
              (!w.createdAt?.gte || r.createdAt >= w.createdAt.gte) &&
              (!w.createdAt?.lte || r.createdAt <= w.createdAt.lte),
          )
          .sort((a, b) => b.id - a.id)
          .slice(0, args.take);
      }),
      count: vi.fn(async () => rows.length),
    },
    user: {
      findMany: vi.fn(async () => [
        { id: 3, displayName: 'Ben' },
        { id: 1, displayName: 'Boss' },
      ]),
    },
  };
}

const at = new Date('2026-11-12T20:00:00.000Z');

describe('recordBillEvent', () => {
  it('writes who did it and who approved it, with their names', async () => {
    const db = fakeDb();
    const ok = await recordBillEvent(
      {
        kind: 'VOID_ITEM',
        area: 'Main',
        tableLabel: 'T1',
        actorUserId: 3,
        approvedById: 1,
        amount: 4.5,
        source: 'phone',
        details: { lines: [{ name: 'Espresso', qty: 3, unitPrice: 1.5 }] },
      },
      { db, now: () => at },
    );
    expect(ok).toBe(true);
    expect(db.rows[0]).toMatchObject({
      kind: 'VOID_ITEM',
      actorUserId: 3,
      actorName: 'Ben',
      approvedById: 1,
      approverName: 'Boss',
      amount: '4.50',
      source: 'phone',
      createdAt: at,
    });
  });

  it('tries once more when the write fails', async () => {
    const db = fakeDb({ failCreates: 1 });
    expect(
      await recordBillEvent(
        { kind: 'VOID_TICKET', area: 'Main', tableLabel: 'T1' },
        { db },
      ),
    ).toBe(true);
    expect(db.rows).toHaveLength(1);
  });

  it('never throws, and says so, when it cannot be written', async () => {
    const db = fakeDb({ failCreates: 5 });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await recordBillEvent(
        { kind: 'AUTO_VOID', area: 'Main', tableLabel: 'T1' },
        { db },
      ),
    ).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('does not keep an id that is not a user id', async () => {
    const db = fakeDb();
    await recordBillEvent(
      {
        kind: 'DISCOUNT',
        area: 'Main',
        tableLabel: 'T1',
        actorUserId: -4,
        approvedById: 0,
      },
      { db },
    );
    expect(db.rows[0].actorUserId).toBeNull();
    expect(db.rows[0].approvedById).toBeNull();
  });
});

describe('billEventLines', () => {
  it('keeps what a reader needs and adds up what came off', () => {
    const lines = billEventLines([
      { name: 'Espresso', sku: 'ESP', qty: 2, unitPrice: 1.5, note: 'x' },
      { name: '', qty: 'abc', unitPrice: 3 },
    ]);
    expect(lines).toEqual([
      { name: 'Espresso', sku: 'ESP', qty: 2, unitPrice: 1.5 },
      { name: 'Item', qty: 0, unitPrice: 3 },
    ]);
    expect(billEventLinesAmount(lines)).toBe(3);
    expect(billEventLines(null)).toEqual([]);
  });
});

describe('billEventsOfPayment', () => {
  const settings = {
    preferences: {
      serviceCharge: { enabled: true, mode: 'PERCENT', value: 10 },
    },
  };
  const pay = (meta: Record<string, unknown>) => ({
    area: 'Main',
    tableLabel: 'T1',
    meta: { kind: 'PAYMENT', userId: 3, baseTotal: 20, ...meta },
  });

  it('finds nothing in a plain payment', () => {
    expect(
      billEventsOfPayment(
        pay({ serviceChargeAmount: 2, totalAfter: 22 }),
        settings,
        'till',
      ),
    ).toEqual([]);
  });

  it('records a discount with the approval the till checked', () => {
    const [e] = billEventsOfPayment(
      pay({
        serviceChargeAmount: 2,
        discountAmount: 5,
        discountType: 'AMOUNT',
        discountReason: 'regular',
        managerApprovedById: 1,
      }),
      settings,
      'phone',
    );
    expect(e).toMatchObject({
      kind: 'DISCOUNT',
      amount: 5,
      reason: 'regular',
      actorUserId: 3,
      approvedById: 1,
      source: 'phone',
    });
  });

  it('does not state an approver the till never checked', () => {
    const [e] = billEventsOfPayment(
      pay({
        serviceChargeAmount: 2,
        discountAmount: 5,
        managerApprovedById: 1,
      }),
      {
        ...settings,
        security: { approvals: { requireManagerPinForDiscount: false } },
      },
      'phone',
    );
    expect(e.approvedById).toBeNull();
    expect(e.details).toMatchObject({ approverNamedByDevice: 1 });
  });

  it('records the service charge left off, at what it would have been', () => {
    const [e] = billEventsOfPayment(
      pay({ serviceChargeAmount: 0 }),
      settings,
      'till',
    );
    expect(e).toMatchObject({ kind: 'SERVICE_CHARGE_REMOVED', amount: 2 });
  });

  it('records a price the till corrected', () => {
    const events = billEventsOfPayment(
      pay({
        serviceChargeAmount: 2,
        linePriceCheck: { detail: 'Espresso price 0.50 → 1.50', issues: [{}] },
        totalsMismatch: { detail: 'total 1 vs 3', delta: -2, claimedTotal: 1 },
      }),
      settings,
      'phone',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'PRICE_CORRECTED', amount: 2 });
    expect(events[0].reason).toContain('Espresso');
  });

  it('ignores reprints and kitchen slips', () => {
    expect(
      billEventsOfPayment(
        pay({ reprint: true, discountAmount: 5 }),
        settings,
        'till',
      ),
    ).toEqual([]);
    expect(
      billEventsOfPayment(
        { area: 'Main', tableLabel: 'T1', meta: { kind: 'ORDER' } },
        settings,
        'till',
      ),
    ).toEqual([]);
  });
});

describe('listBillEvents', () => {
  it('lists newest first, filtered and paged', async () => {
    const db = fakeDb();
    for (const kind of ['VOID_ITEM', 'DISCOUNT', 'VOID_ITEM'] as const) {
      await recordBillEvent(
        { kind, area: 'Main', tableLabel: 'T1', actorUserId: 3 },
        { db, now: () => at },
      );
    }
    const all = await listBillEvents({}, { db });
    expect(all.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(all[0].createdAt).toBe(at.toISOString());
    const voids = await listBillEvents({ kinds: ['VOID_ITEM'] }, { db });
    expect(voids.map((r) => r.id)).toEqual([3, 1]);
    const older = await listBillEvents({ beforeId: 3, limit: 1 }, { db });
    expect(older.map((r) => r.id)).toEqual([2]);
    // An unknown kind is ignored, not passed to the query.
    expect(await listBillEvents({ kinds: ['NOPE'] }, { db })).toHaveLength(3);
  });
});
