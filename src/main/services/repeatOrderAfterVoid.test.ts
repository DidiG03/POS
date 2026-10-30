/**
 * QA round 4, #1: a repeat order after a void was printed but never billed.
 *
 * Send, void and kitchen slip run against one in-memory bill here: what the
 * Send writes is what the void reads, and what the slip prints.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withLineIds } from '@shared/ticketLineIds';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  stock: new Map<string, number>(),
}));

vi.mock('@db/client', () => ({
  prisma: {
    ticketLog: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          h.rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        h.rows.filter((r) =>
          (where?.idempotencyKey?.in || []).includes(r.idempotencyKey),
        ),
      ),
      create: vi.fn(async ({ data }: any) => {
        if (
          data.idempotencyKey &&
          h.rows.some((r) => r.idempotencyKey === data.idempotencyKey)
        ) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: h.rows.length + 1, ...data };
        h.rows.push(row);
        return row;
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
vi.mock('./core', () => ({
  withTableLock: (_a: string, _l: string, fn: () => any) => fn(),
  coreServices: { isTableOpen: vi.fn(async () => true) },
}));
vi.mock('./tableOpen', () => ({
  ensureOccupiedForTicketWrite: vi.fn(async () => undefined),
  applyTableOpenState: vi.fn(async () => true),
}));
vi.mock('./tableOccupancy', () => ({
  occupancyIntentIsStale: vi.fn(async () => false),
}));
vi.mock('./license', () => ({ storePlanBlocksTables: () => false }));
// The real lookup, minus the occupancy window: every row is this sitting.
vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: vi.fn(async () => {
    const last = h.rows.at(-1);
    if (!last) return null;
    return {
      ...last,
      itemsJson: withLineIds(last.itemsJson, { seed: last.id }),
    };
  }),
  getCurrentSessionOwnerId: vi.fn(async () => h.rows.at(-1)?.userId ?? null),
  getCurrentTableSessionKey: vi.fn(async () => 'sess'),
}));
vi.mock('./menuStock', async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    restoreDailyStockForLines: vi.fn(async (_db: unknown, lines: any[]) => {
      for (const l of lines) {
        h.stock.set(l.sku, (h.stock.get(l.sku) ?? 0) + Number(l.qty));
      }
    }),
  };
});
// Bill row and stock count in one step, as the real transaction does.
vi.mock('./ticketLogWrite', async () => {
  const { OutOfStockError } = await import('./menuStock');
  return {
    writeTicketSnapshot: vi.fn(async (input: any) => {
      const next = new Map(h.stock);
      for (const l of input.stockConsumeLines ?? []) {
        if (!next.has(l.sku)) continue;
        const left = next.get(l.sku)! - Number(l.qty);
        if (left < 0) {
          throw new OutOfStockError(
            { sku: l.sku, name: l.sku },
            next.get(l.sku)!,
            Number(l.qty),
          );
        }
        next.set(l.sku, left);
      }
      if (
        input.idempotencyKey &&
        h.rows.some((r) => r.idempotencyKey === input.idempotencyKey)
      ) {
        return 'duplicate';
      }
      h.rows.push({
        id: h.rows.length + 1,
        userId: input.userId,
        area: input.area,
        tableLabel: input.tableLabel,
        covers: input.covers,
        itemsJson: input.items,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
        sessionKey: input.sessionKey,
      });
      h.stock = next;
      return 'written';
    }),
  };
});

import { recordTicketSend } from './ticketSend';
import { voidTicketItem } from './ticketVoid';
import { checkOrderSlip } from './orderSlip';

const table = { area: 'Salla', tableLabel: 'Q1' };
const espresso = { sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 1.5 };

/**
 * A QA script's Send: no Send key, and the bill as it read it (the live
 * lines, with their ids) plus what it orders now.
 */
async function keylessSend(items: any[] = [...live(), espresso]) {
  const r = await recordTicketSend({
    userId: 7,
    ...table,
    covers: 2,
    note: null,
    items,
  });
  expect(r.ok).toBe(true);
  return r as any;
}

function bill(): any[] {
  return h.rows.at(-1)?.itemsJson ?? [];
}
const live = () => bill().filter((l) => !l.voided && !l.paid);

async function voidLine(lineId: string, key: string) {
  return voidTicketItem({
    ...table,
    item: { ...espresso, lineId },
    idempotencyKey: key,
  });
}

async function slipFor(sendKey?: string) {
  return checkOrderSlip({
    ...table,
    meta: { kind: 'ORDER', ...(sendKey ? { sendKey } : {}) },
  });
}

beforeEach(() => {
  h.rows = [];
  h.stock = new Map([['ESP', 3]]);
});

describe('repeat order after a void', () => {
  it('a keyless Send after a void is billed, printed once and counted once', async () => {
    const first = await keylessSend();
    expect(first.written).toBe(true);
    expect(h.stock.get('ESP')).toBe(2);

    expect(await voidLine(bill()[0].lineId, 'void-1')).toBe('ok');
    expect(h.stock.get('ESP')).toBe(3);
    expect(live()).toHaveLength(0);

    // QA: sends 2 and 3 of the same Espresso were folded into the voided
    // line: printed, never billed, never counted.
    const second = await keylessSend();
    const third = await keylessSend();
    expect(second.written).toBe(true);
    expect(third.written).toBe(true);
    expect(live()).toHaveLength(2);
    expect(bill().filter((l) => l.voided)).toHaveLength(1);
    expect(new Set(bill().map((l) => l.lineId)).size).toBe(3);
    expect(h.stock.get('ESP')).toBe(1);

    // Each slip prints its own Send's line, and only that.
    for (const r of [second, third]) {
      const slip = await slipFor(r.sendKey);
      expect(slip.kind).toBe('print');
      expect((slip as any).items).toHaveLength(1);
      expect((slip as any).items[0]).toMatchObject({
        sku: 'ESP',
        sendKey: r.sendKey,
      });
    }
    // The voided Send's slip no longer prints; a keyless slip never did.
    expect((await slipFor(first.sendKey)).kind).toBe('refuse');
    expect((await slipFor()).kind).toBe('refuse');
  });

  it('refuses the Send beyond stock instead of accepting it', async () => {
    await keylessSend();
    await keylessSend();
    await keylessSend();
    expect(h.stock.get('ESP')).toBe(0);
    const fourth = await recordTicketSend({
      userId: 7,
      ...table,
      covers: 2,
      note: null,
      items: [...live(), espresso],
    });
    expect(fourth).toMatchObject({ ok: false, code: 'OUT_OF_STOCK' });
    expect(live()).toHaveLength(3);
  });

  it('a new line is never saved voided on an older bill without line ids', async () => {
    // Table Q1: bill written before line ids, its Espresso voided.
    h.rows.push({
      id: 1,
      userId: 7,
      ...table,
      covers: 2,
      itemsJson: [{ ...espresso, fired: true, voided: true }],
      idempotencyKey: null,
    });
    const r = await keylessSend();
    expect(r.written).toBe(true);
    expect(bill()).toHaveLength(2);
    expect(bill()[1]).toMatchObject({ sku: 'ESP' });
    expect(bill()[1].voided).not.toBe(true);
    expect(h.stock.get('ESP')).toBe(2);
  });

  it('a keyed Send after a void adds a live line, whatever the snapshot says', async () => {
    await recordTicketSend({
      userId: 7,
      ...table,
      covers: 2,
      note: null,
      idempotencyKey: 'k1',
      items: [{ ...espresso, fired: true, sendKey: 'k1', lineId: 'c1' }],
      addedItems: [{ ...espresso, fired: true, sendKey: 'k1', lineId: 'c1' }],
    });
    expect(await voidLine('c1', 'void-k')).toBe('ok');
    // The phone has not seen the void yet: its copy of line c1 is live.
    const r: any = await recordTicketSend({
      userId: 7,
      ...table,
      covers: 2,
      note: null,
      idempotencyKey: 'k2',
      items: [
        { ...espresso, fired: true, sendKey: 'k1', lineId: 'c1' },
        { ...espresso, fired: true, sendKey: 'k2', lineId: 'c2' },
      ],
      addedItems: [{ ...espresso, fired: true, sendKey: 'k2', lineId: 'c2' }],
    });
    expect(r.written).toBe(true);
    expect(bill().find((l) => l.lineId === 'c1').voided).toBe(true);
    expect(bill().find((l) => l.lineId === 'c2').voided).not.toBe(true);
    expect(h.stock.get('ESP')).toBe(2);
    const slip: any = await slipFor('k2');
    expect(slip.items.map((l: any) => l.lineId)).toEqual(['c2']);
  });

  it('a void names one line: the other Espresso stays', async () => {
    await keylessSend();
    await keylessSend();
    const [a, b] = bill();
    expect(await voidLine(b.lineId, 'void-b')).toBe('ok');
    expect(live().map((l) => l.lineId)).toEqual([a.lineId]);
  });
});

describe('two Sends of the same item (#10)', () => {
  it('a snapshot-style client gets one line per Send', async () => {
    await keylessSend();
    // The device sends the bill it has plus one more Espresso: 2x.
    await keylessSend();
    expect(bill()).toHaveLength(2);
    expect(bill().map((l) => l.qty)).toEqual([1, 1]);
    expect(new Set(bill().map((l) => l.sendKey)).size).toBe(2);
  });

  it('resending the same bill adds nothing', async () => {
    await keylessSend([espresso]);
    const again = await keylessSend([...bill()]);
    expect(again.written).toBe(false);
    expect(bill()).toHaveLength(1);
    expect(h.stock.get('ESP')).toBe(2);
  });
});

describe('phones that send only their new lines (QA round 5, #2)', () => {
  /** A ≤0.2.98 phone: keyed, but its payload is just this Send's line. */
  async function deltaSend(key: string, withAdded = true) {
    const line = { ...espresso, fired: true, sendKey: key };
    const r: any = await recordTicketSend({
      userId: 7,
      ...table,
      covers: 2,
      note: null,
      idempotencyKey: key,
      items: [line],
      addedItems: withAdded ? [line] : null,
    });
    expect(r.ok).toBe(true);
    return r;
  }

  for (const withAdded of [true, false]) {
    it(`a repeat after a void is billed, printed and counted once (addedItems: ${withAdded})`, async () => {
      await deltaSend('k1', withAdded);
      expect(await voidLine(bill()[0].lineId, 'void-1')).toBe('ok');
      expect(h.stock.get('ESP')).toBe(3);

      await deltaSend('k2', withAdded);
      await deltaSend('k3', withAdded);
      // QA: the bill showed 1 while the slips and stock counted 3.
      expect(bill()).toHaveLength(3);
      expect(live().map((l) => l.sendKey)).toEqual(['k2', 'k3']);
      expect(bill()[0]).toMatchObject({ sendKey: 'k1', voided: true });
      expect(h.stock.get('ESP')).toBe(1);
      for (const key of ['k2', 'k3']) {
        const slip: any = await slipFor(key);
        expect(slip.kind).toBe('print');
        expect(slip.items).toHaveLength(1);
      }
      // A replayed Send changes nothing and counts nothing.
      const again = await deltaSend('k3', withAdded);
      expect(again.written).toBe(false);
      expect(bill()).toHaveLength(3);
      expect(h.stock.get('ESP')).toBe(1);
    });
  }
});
