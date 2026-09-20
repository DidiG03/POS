import { describe, expect, it, beforeEach } from 'vitest';
import { invalidateCachePrefix } from './swrCache';
import { cacheLatestTicket, ingestFloorSnapshot } from './posReadCache';
import { decideHostBill, peekTableBill, peekTableBillTotal } from './tableBill';

const SNAP = {
  tables: [
    {
      area: 'Salla',
      label: 'T7',
      openedAt: '2026-09-11T13:55:42.708Z',
      userId: 1,
      covers: 2,
      total: 600,
      items: [{ name: 'Sallatë cezar', qty: 1, unitPrice: 600 }],
      note: 'no salt',
    },
  ],
};

describe('peekTableBill', () => {
  beforeEach(() => {
    invalidateCachePrefix('pos:ticket:');
    invalidateCachePrefix('pos:floor:');
  });

  it('returns snapshot lines even when the ticket cache is empty', () => {
    ingestFloorSnapshot(SNAP, { area: 'Salla' });
    expect(peekTableBill('Salla', 'T7')).toEqual({
      items: [{ name: 'Sallatë cezar', qty: 1, unitPrice: 600 }],
      note: 'no salt',
    });
  });

  it('does not treat an empty snapshot row as the bill', () => {
    ingestFloorSnapshot({
      tables: [
        {
          ...SNAP.tables[0],
          items: [],
          total: 0,
          note: null,
        },
      ],
    });
    expect(peekTableBill('Salla', 'T7')).toBeNull();
  });

  it('does not use a leftover ticket cache when the table is missing from the floor', () => {
    ingestFloorSnapshot({ tables: [] }, { area: 'Salla' });
    cacheLatestTicket('Salla', 'T7', {
      items: [{ name: 'Sallatë cezar', qty: 1, unitPrice: 600 }],
      note: '',
    });
    expect(peekTableBill('Salla', 'T7')).toBeNull();
  });
});

describe('decideHostBill', () => {
  const empty = { ok: true as const, items: [], note: '' };

  it('hydrates live lines from the host', () => {
    expect(
      decideHostBill({
        read: {
          ok: true,
          items: [{ name: 'Byrek', qty: 1 }],
          note: '',
        },
        currentLines: [],
        hasCovers: false,
        suppressClose: false,
        withinPostSendGrace: false,
      }),
    ).toEqual({
      kind: 'hydrate',
      items: [{ name: 'Byrek', qty: 1 }],
      note: '',
    });
  });

  it('does not paint empty on an occupied table with covers', () => {
    expect(
      decideHostBill({
        read: empty,
        currentLines: [],
        hasCovers: true,
        suppressClose: false,
        withinPostSendGrace: false,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('keeps local live lines when the host read is empty', () => {
    expect(
      decideHostBill({
        read: empty,
        currentLines: [{ voided: false }],
        hasCovers: false,
        suppressClose: false,
        withinPostSendGrace: false,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('reports unreadable instead of empty when the host fails', () => {
    expect(
      decideHostBill({
        read: { ok: false },
        currentLines: [],
        hasCovers: true,
        suppressClose: false,
        withinPostSendGrace: false,
      }),
    ).toEqual({ kind: 'unreadable' });
  });

  it('closes a genuinely empty table with no covers', () => {
    expect(
      decideHostBill({
        read: empty,
        currentLines: [],
        hasCovers: false,
        suppressClose: false,
        withinPostSendGrace: false,
      }),
    ).toEqual({ kind: 'empty', note: '' });
  });

  /**
   * The blank-ticket-on-an-occupied-table report: the floor paints a real
   * total for the sitting, the read hands back nothing, and the old rules
   * called that `keep` — a blank cart the next send would rewrite the bill to.
   */
  it('reports unreadable when the floor still shows money on the table', () => {
    expect(
      decideHostBill({
        read: empty,
        currentLines: [],
        hasCovers: true,
        suppressClose: false,
        withinPostSendGrace: false,
        expectedTotal: 1200,
      }),
    ).toEqual({ kind: 'unreadable' });
  });

  it('leaves a freshly opened table with covers alone', () => {
    expect(
      decideHostBill({
        read: empty,
        currentLines: [],
        hasCovers: true,
        suppressClose: false,
        withinPostSendGrace: false,
        expectedTotal: 0,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('does not flag a table the floor knows nothing about', () => {
    expect(
      decideHostBill({
        read: empty,
        currentLines: [],
        hasCovers: true,
        suppressClose: false,
        withinPostSendGrace: false,
        expectedTotal: null,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('prefers the local draft over the banner right after a send', () => {
    expect(
      decideHostBill({
        read: empty,
        currentLines: [{ voided: false }],
        hasCovers: true,
        suppressClose: false,
        withinPostSendGrace: true,
        expectedTotal: 1200,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('still hydrates when the read and the floor agree', () => {
    expect(
      decideHostBill({
        read: { ok: true, items: [{ name: 'Byrek', qty: 1 }], note: '' },
        currentLines: [],
        hasCovers: true,
        suppressClose: false,
        withinPostSendGrace: false,
        expectedTotal: 300,
      }),
    ).toEqual({
      kind: 'hydrate',
      items: [{ name: 'Byrek', qty: 1 }],
      note: '',
    });
  });
});

describe('peekTableBillTotal', () => {
  beforeEach(() => {
    invalidateCachePrefix('pos:ticket:');
    invalidateCachePrefix('pos:floor:');
  });

  it('reads the sitting total the floor last painted', () => {
    ingestFloorSnapshot(SNAP, { area: 'Salla' });
    expect(peekTableBillTotal('Salla', 'T7')).toBe(600);
  });

  it('reports a total even when the snapshot ships no lines', () => {
    ingestFloorSnapshot(
      {
        tables: [{ ...SNAP.tables[0], items: [] }],
      },
      { area: 'Salla' },
    );
    expect(peekTableBillTotal('Salla', 'T7')).toBe(600);
  });

  it('returns null for a table the floor has not reported', () => {
    ingestFloorSnapshot(SNAP, { area: 'Salla' });
    expect(peekTableBillTotal('Salla', 'T9')).toBeNull();
  });
});
