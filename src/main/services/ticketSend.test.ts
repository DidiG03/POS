import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  existing: null as any,
  users: new Map<number, any>(),
  open: true,
  closedAfter: false,
  latest: null as any,
  ownerId: null as number | null,
  written: [] as any[],
  ensured: [] as string[],
  keyRows: [] as any[],
  sessionKey: 'Salla\u001f4\u001f2026' as string | null,
}));

vi.mock('@db/client', () => ({
  prisma: {
    ticketLog: {
      findFirst: vi.fn(async () => h.existing),
      findMany: vi.fn(async ({ where }: any) =>
        h.keyRows.filter((r: any) =>
          where.idempotencyKey.in.includes(r.idempotencyKey),
        ),
      ),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: any) => h.users.get(where.id) || null,
      ),
    },
  },
}));
vi.mock('./core', () => ({
  withTableLock: (_a: string, _l: string, fn: () => any) => fn(),
  coreServices: { isTableOpen: vi.fn(async () => h.open) },
}));
vi.mock('./tableOpen', () => ({
  ensureOccupiedForTicketWrite: vi.fn(async (a: string, l: string) => {
    h.ensured.push(`${a}/${l}`);
  }),
}));
vi.mock('./tableOccupancy', () => ({
  occupancyIntentIsStale: vi.fn(async () => h.closedAfter),
}));
vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: vi.fn(async () => h.latest),
  getCurrentSessionOwnerId: vi.fn(async () => h.ownerId),
  getCurrentTableSessionKey: vi.fn(async () => h.sessionKey),
}));
vi.mock('./ticketLogWrite', () => ({
  writeTicketSnapshot: vi.fn(async (input: any) => {
    h.written.push(input);
    return 'written';
  }),
}));

import {
  linesNewToBill,
  recordTicketSend,
  ticketCapturedAt,
  validateTicketSendLines,
} from './ticketSend';

const kafe = { sku: 'KAFE', name: 'Kafe', qty: 1, unitPrice: 100, fired: true };
const birre = {
  sku: 'BIRRE',
  name: 'Birre',
  qty: 1,
  unitPrice: 300,
  fired: true,
};

const base = {
  userId: 7,
  area: 'Salla',
  tableLabel: '4',
  covers: 2,
  note: null,
  idempotencyKey: 'send-1',
};

beforeEach(() => {
  h.existing = null;
  h.users = new Map([
    [7, { id: 7, role: 'WAITER', displayName: 'Ana' }],
    [8, { id: 8, role: 'WAITER', displayName: 'Ben' }],
    [1, { id: 1, role: 'ADMIN', displayName: 'Boss' }],
  ]);
  h.open = true;
  h.closedAfter = false;
  h.latest = null;
  h.ownerId = null;
  h.written = [];
  h.ensured = [];
  h.keyRows = [];
  h.sessionKey = 'Salla\u001f4\u001f2026';
});

describe('recordTicketSend', () => {
  it('is a no-op for a Send already recorded', async () => {
    h.existing = { id: 1 };
    expect(await recordTicketSend({ ...base, items: [kafe] })).toEqual({
      ok: true,
      written: false,
    });
    expect(h.written).toHaveLength(0);
  });

  it('refuses an order taken before the table was closed, without reopening it', async () => {
    h.open = false;
    h.closedAfter = true;
    const r = await recordTicketSend({
      ...base,
      items: [kafe],
      capturedAt: Date.now() - 60_000,
    });
    expect(r).toMatchObject({ ok: false, code: 'TABLE_CLOSED' });
    expect(h.ensured).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });

  it('opens a closed table for an order taken after it closed', async () => {
    h.open = false;
    h.closedAfter = false;
    const r = await recordTicketSend({
      ...base,
      items: [kafe],
      capturedAt: Date.now(),
    });
    expect(r).toMatchObject({ ok: true, written: true });
    expect(h.ensured).toEqual(['Salla/4']);
  });

  it('refuses another waiter’s sitting, but not an admin', async () => {
    h.ownerId = 8;
    expect(await recordTicketSend({ ...base, items: [kafe] })).toMatchObject({
      ok: false,
      code: 'TABLE_OWNED_BY_OTHER',
      ownerName: 'Ben',
    });
    expect(
      await recordTicketSend({ ...base, userId: 1, items: [kafe] }),
    ).toMatchObject({ ok: true, written: true });
  });

  it('a late Send adds only its lines to the newer bill', async () => {
    h.latest = {
      createdAt: new Date(Date.now() - 1_000),
      itemsJson: [kafe, birre],
    };
    const r = await recordTicketSend({
      ...base,
      idempotencyKey: 'send-late',
      items: [
        kafe,
        { ...birre, sku: 'UJE', name: 'Uje', sendKey: 'send-late' },
      ],
      addedItems: [{ ...birre, sku: 'UJE', name: 'Uje' }],
      capturedAt: Date.now() - 30_000,
    });
    expect(r).toMatchObject({ ok: true, written: true, mode: 'stale-delta' });
    expect(h.written[0].items.map((l: any) => l.name)).toEqual([
      'Kafe',
      'Birre',
      'Uje',
    ]);
  });

  it('keeps the bill’s voids even from a Send built before them', async () => {
    h.latest = {
      createdAt: new Date(Date.now() - 60_000),
      itemsJson: [{ ...birre, voided: true }, kafe],
    };
    await recordTicketSend({ ...base, items: [birre, kafe] });
    const live = h.written[0].items.filter((l: any) => !l.voided);
    expect(live.map((l: any) => l.name)).toEqual(['Kafe']);
  });
});

describe('a screen still showing a closed bill', () => {
  it('cannot start a new sitting with the old, paid lines', async () => {
    // The table was paid on another device; this phone's cart still has the
    // coffee its earlier Send (old-send) put on that sitting.
    h.open = false;
    h.sessionKey = null;
    h.keyRows = [
      { idempotencyKey: 'old-send', sessionKey: 'Salla\u001f4\u001fyesterday' },
    ];
    const r = await recordTicketSend({
      ...base,
      idempotencyKey: 'new-send',
      items: [
        { ...kafe, sendKey: 'old-send' },
        { ...birre, sendKey: 'new-send' },
      ],
      addedItems: [birre],
      capturedAt: Date.now(),
    });
    expect(r).toMatchObject({ ok: false, code: 'TABLE_CLOSED' });
    expect(h.ensured).toHaveLength(0);
  });

  it('accepts lines whose Send the till has not seen yet (still queued)', async () => {
    h.open = false;
    h.sessionKey = null;
    const r = await recordTicketSend({
      ...base,
      idempotencyKey: 'new-send',
      items: [
        { ...kafe, sendKey: 'queued-send' },
        { ...birre, sendKey: 'new-send' },
      ],
      capturedAt: Date.now(),
    });
    expect(r).toMatchObject({ ok: true, written: true });
  });

  it('accepts earlier Sends of the same sitting', async () => {
    h.keyRows = [
      { idempotencyKey: 'earlier', sessionKey: 'Salla\u001f4\u001f2026' },
    ];
    const r = await recordTicketSend({
      ...base,
      idempotencyKey: 'now',
      items: [
        { ...kafe, sendKey: 'earlier' },
        { ...birre, sendKey: 'now' },
      ],
    });
    expect(r).toMatchObject({ ok: true, written: true });
  });
});

describe('what the kitchen gets', () => {
  it('a replay whose rows were compacted away cooks nothing again', async () => {
    // The idempotency row is gone, but the bill still carries its lines.
    h.latest = {
      createdAt: new Date(Date.now() - 60_000),
      itemsJson: [
        { ...kafe, sendKey: 's1' },
        { ...birre, sendKey: 's2' },
      ],
    };
    const r = await recordTicketSend({
      ...base,
      idempotencyKey: 's1',
      items: [{ ...kafe, sendKey: 's1' }],
      addedItems: [kafe],
      capturedAt: Date.now() - 120_000,
    });
    expect(r).toEqual({ ok: true, written: false });
    expect(h.written).toHaveLength(0);
  });

  it('cooks and counts only lines new to the bill', async () => {
    h.latest = {
      createdAt: new Date(Date.now() - 60_000),
      itemsJson: [{ ...kafe, sendKey: 's1' }],
    };
    const r: any = await recordTicketSend({
      ...base,
      idempotencyKey: 's2',
      items: [
        { ...kafe, sendKey: 's1' },
        { ...birre, sendKey: 's2' },
      ],
      addedItems: [birre],
      stockConsumeLines: [{ sku: 'IGNORED', qty: 9 }],
    });
    expect(r.firedNow.map((l: any) => l.name)).toEqual(['Birre']);
    expect(h.written[0].stockConsumeLines).toEqual([{ sku: 'BIRRE', qty: 1 }]);
  });

  it('a later Send carrying a queued one cooks both, once', async () => {
    const r: any = await recordTicketSend({
      ...base,
      idempotencyKey: 's2',
      items: [
        { ...kafe, sendKey: 's1' },
        { ...birre, sendKey: 's2' },
      ],
      addedItems: [birre],
    });
    expect(r.firedNow.map((l: any) => l.name)).toEqual(['Kafe', 'Birre']);
  });

  it('falls back to the payload for older phones without Send keys', async () => {
    const r: any = await recordTicketSend({
      ...base,
      items: [kafe],
      stockConsumeLines: [{ sku: 'KAFE', qty: 1 }],
    });
    expect(r.firedNow).toBeNull();
    expect(h.written[0].stockConsumeLines).toEqual([{ sku: 'KAFE', qty: 1 }]);
  });

  it('never cooks a held course line or a void', () => {
    expect(
      linesNewToBill(
        [
          { ...kafe, sendKey: 'n', fired: false },
          { ...birre, sendKey: 'n', voided: true },
        ],
        [],
      ),
    ).toEqual([]);
  });
});

describe('ticketCapturedAt', () => {
  it('turns the device-measured age into a till-clock time', () => {
    expect(ticketCapturedAt({ intentAgeMs: 5_000 }, 100_000)).toBe(95_000);
    expect(ticketCapturedAt({}, 100_000)).toBeNull();
    expect(ticketCapturedAt({ intentAgeMs: -1 }, 100_000)).toBeNull();
    expect(ticketCapturedAt(null)).toBeNull();
  });
});

describe('validateTicketSendLines', () => {
  const ok = (items: unknown[], label: unknown = '4') =>
    validateTicketSendLines({ area: 'Salla', tableLabel: label, items });

  it('refuses quantities and prices that cannot be real', () => {
    for (const qty of [-5, 'abc', 1e12, '1e400', Infinity, null]) {
      expect(ok([{ ...kafe, qty }])).toMatchObject({ ok: false });
    }
    for (const unitPrice of [-1000, 'abc', 1e12]) {
      expect(ok([{ ...kafe, unitPrice }])).toMatchObject({ ok: false });
    }
  });

  it('drops zero-quantity lines and turns numeric strings into numbers', () => {
    const r = ok([
      { ...kafe, qty: 0 },
      { ...birre, qty: '2', unitPrice: '300' },
    ]);
    expect(r).toEqual({
      ok: true,
      items: [{ ...birre, qty: 2, unitPrice: 300 }],
    });
  });

  it('keeps weighed fractions', () => {
    expect(ok([{ ...kafe, qty: 0.35 }])).toMatchObject({ ok: true });
  });

  it('refuses blank or control-character table names and nameless lines', () => {
    expect(ok([kafe], '   ')).toMatchObject({ ok: false });
    expect(ok([kafe], 'T\u001f1')).toMatchObject({ ok: false });
    expect(ok([{ qty: 1, unitPrice: 1 }])).toMatchObject({ ok: false });
    expect(ok([{ sku: { $gt: '' }, name: { a: 1 }, qty: 1 }])).toMatchObject({
      ok: false,
    });
    expect(ok(['x'])).toMatchObject({ ok: false });
  });

  it('a Send with a bad line writes nothing', async () => {
    const r = await recordTicketSend({
      ...base,
      items: [kafe, { ...birre, qty: -3 }],
    });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ORDER' });
    expect(h.written).toHaveLength(0);
  });
});
