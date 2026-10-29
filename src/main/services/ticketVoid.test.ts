import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  closed: [] as string[],
  locks: 0,
}));

vi.mock('@db/client', () => ({
  prisma: {
    ticketLog: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          h.rows.find((r) => r.idempotencyKey === where.idempotencyKey) || null,
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
  },
}));
vi.mock('./core', () => ({
  withTableLock: async (_a: string, _l: string, fn: () => any) => {
    h.locks += 1;
    return fn();
  },
}));
vi.mock('./tableOpen', () => ({
  applyTableOpenState: vi.fn(async (a: string, l: string, open: boolean) => {
    if (!open) h.closed.push(`${a}/${l}`);
    return true;
  }),
}));
vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: vi.fn(
    async () => h.rows.at(-1) || null,
  ),
}));

import { itemVoidReplay, voidTicketItem, voidWholeTicket } from './ticketVoid';

const uje = { sku: 'UJE', name: 'Uje', qty: 1, unitPrice: 100 };

beforeEach(() => {
  h.closed = [];
  h.locks = 0;
  h.rows = [
    {
      id: 1,
      userId: 7,
      area: 'Salla',
      tableLabel: '4',
      covers: 2,
      note: 'window',
      sessionKey: 'sess',
      itemsJson: [
        { ...uje, lineId: 'a' },
        { ...uje, lineId: 'b' },
        { ...uje, sku: 'PIZZA', name: 'Pizza', paid: true, lineId: 'p' },
      ],
    },
  ];
});

describe('voidTicketItem', () => {
  it('writes the void as a new version that keeps owner, session and covers', async () => {
    expect(
      await voidTicketItem({
        area: 'Salla',
        tableLabel: '4',
        item: { ...uje, lineId: 'b' },
        idempotencyKey: 'void-1',
      }),
    ).toBe('ok');
    expect(h.locks).toBe(1);
    const next = h.rows.at(-1);
    expect(next).toMatchObject({
      userId: 7,
      sessionKey: 'sess',
      covers: 2,
      note: 'window',
      idempotencyKey: 'void-1',
    });
    expect(next.itemsJson.filter((l: any) => l.voided)).toEqual([
      { ...uje, lineId: 'b', voided: true, voidKey: 'void-1' },
    ]);
    // The previous version is untouched.
    expect(h.rows[0].itemsJson.some((l: any) => l.voided)).toBe(false);
  });

  it('a retried void does not strike the next identical line', async () => {
    const input = {
      area: 'Salla',
      tableLabel: '4',
      item: { ...uje, lineId: 'a' },
      idempotencyKey: 'void-2',
    };
    expect(await voidTicketItem(input)).toBe('ok');
    expect(await voidTicketItem(input)).toBe('duplicate');
    expect(
      h.rows.at(-1).itemsJson.filter((l: any) => l.name === 'Uje' && l.voided),
    ).toHaveLength(1);
  });

  it('refuses a paid line', async () => {
    expect(
      await voidTicketItem({
        area: 'Salla',
        tableLabel: '4',
        item: { lineId: 'p', sku: 'PIZZA', name: 'Pizza', qty: 1 },
      }),
    ).toBe('paid');
    expect(h.rows).toHaveLength(1);
  });

  it('never picks a line by name: no line id, nothing voided', async () => {
    expect(
      await voidTicketItem({
        area: 'Salla',
        tableLabel: '4',
        item: uje,
        idempotencyKey: 'void-3',
      }),
    ).toBe('no-line-id');
    expect(
      await voidTicketItem({
        area: 'Salla',
        tableLabel: '4',
        item: { ...uje, lineId: 'gone' },
        idempotencyKey: 'void-4',
      }),
    ).toBe('not-found');
    expect(h.rows).toHaveLength(1);
  });

  it('voids a line of a bill written before line ids by its derived id', async () => {
    h.rows[0].itemsJson = [uje, { ...uje }];
    expect(
      await voidTicketItem({
        area: 'Salla',
        tableLabel: '4',
        item: { ...uje, lineId: 'L1.1' },
        idempotencyKey: 'void-5',
      }),
    ).toBe('ok');
    expect(h.rows.at(-1).itemsJson.map((l: any) => l.voided === true)).toEqual([
      false,
      true,
    ]);
  });
});

describe('itemVoidReplay', () => {
  it('tells a retry from the same key reused on another line', async () => {
    expect(await itemVoidReplay('void-6', { ...uje, lineId: 'a' })).toBe('new');
    await voidTicketItem({
      area: 'Salla',
      tableLabel: '4',
      item: { ...uje, lineId: 'a' },
      idempotencyKey: 'void-6',
    });
    expect(await itemVoidReplay('void-6', { ...uje, lineId: 'a' })).toBe(
      'same',
    );
    // QA round 4: same approval and key, different line. Not applied, and
    // must not be answered as if it were.
    expect(await itemVoidReplay('void-6', { ...uje, lineId: 'b' })).toBe(
      'other-line',
    );
    expect(
      h.rows.at(-1).itemsJson.find((l: any) => l.lineId === 'b').voided,
    ).toBeUndefined();
  });
});

describe('voidWholeTicket', () => {
  it('voids, runs the pre-close work, then closes, in one lock', async () => {
    const steps: string[] = [];
    const out = await voidWholeTicket({
      area: 'Salla',
      tableLabel: '4',
      reason: 'walked out',
      idempotencyKey: 'vt-1',
      beforeClose: async () => {
        steps.push(`before-close:${h.closed.length}`);
      },
    });
    expect(out).toBe('ok');
    expect(h.locks).toBe(1);
    expect(steps).toEqual(['before-close:0']);
    expect(h.closed).toEqual(['Salla/4']);
    const last = h.rows.at(-1);
    expect(last.note).toBe('window | VOIDED: walked out');
    expect(last.itemsJson.filter((l: any) => l.paid)).toHaveLength(1);
    expect(
      last.itemsJson.filter((l: any) => !l.paid && !l.voided),
    ).toHaveLength(0);
  });

  it('is a no-op on retry', async () => {
    await voidWholeTicket({
      area: 'Salla',
      tableLabel: '4',
      idempotencyKey: 'vt-2',
    });
    h.closed = [];
    expect(
      await voidWholeTicket({
        area: 'Salla',
        tableLabel: '4',
        idempotencyKey: 'vt-2',
      }),
    ).toBe('duplicate');
    expect(h.closed).toEqual([]);
  });
});
