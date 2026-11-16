import { describe, expect, it } from 'vitest';
import {
  billEventSummary,
  billEventsTotals,
  rangeForPreset,
} from './billEventsView';

const now = new Date(2026, 10, 13, 15, 30);

describe('rangeForPreset', () => {
  it('covers whole local days', () => {
    const t = rangeForPreset('today', now);
    expect(t.from).toEqual(new Date(2026, 10, 13, 0, 0, 0, 0));
    expect(t.to).toEqual(new Date(2026, 10, 13, 23, 59, 59, 999));
    const y = rangeForPreset('yesterday', now);
    expect(y.from.getDate()).toBe(12);
    expect(y.to.getDate()).toBe(12);
    expect(rangeForPreset('last7', now).from).toEqual(
      new Date(2026, 10, 7, 0, 0, 0, 0),
    );
    expect(rangeForPreset('last30', now).from.getMonth()).toBe(9);
  });
});

describe('billEventsTotals', () => {
  it('adds the amounts that are known', () => {
    expect(
      billEventsTotals([
        { amount: 1.1 } as any,
        { amount: null } as any,
        { amount: 2.2 } as any,
      ]),
    ).toEqual({ count: 3, amount: 3.3 });
  });
});

describe('billEventSummary', () => {
  it('names the lines, the discount and the reason', () => {
    const row: any = {
      kind: 'DISCOUNT',
      reason: 'regular',
      details: {
        discountType: 'PERCENT',
        discountValue: 10,
        lines: [
          { name: 'Espresso', qty: 2 },
          { name: 'Water', qty: 1 },
          { name: 'Cake', qty: 1 },
          { name: 'Tea', qty: 1 },
        ],
      },
    };
    expect(billEventSummary(row)).toBe(
      '2 × Espresso, 1 × Water, 1 × Cake, +1 · 10% · regular',
    );
    expect(billEventSummary(row, true)).toContain('1 × Tea');
    expect(billEventSummary({ kind: 'VOID_ITEM', details: null } as any)).toBe(
      '',
    );
  });
});

describe('table moves', () => {
  const move = {
    id: 9,
    kind: 'TABLE_TRANSFERRED',
    area: 'Main',
    tableLabel: 'T1',
    actorUserId: 2,
    actorName: 'Ben',
    approvedById: null,
    approverName: null,
    amount: 6,
    reason: null,
    source: 'phone',
    details: {
      toArea: 'Main',
      toLabel: 'T4',
      fromOwnerName: 'Ben',
      toOwnerName: 'Cara',
      lines: [{ name: 'Beer', qty: 2, unitPrice: 3 }],
    },
    createdAt: '2026-11-16T10:00:00.000Z',
  } as any;

  it('says where the table went and to whom', () => {
    expect(billEventSummary(move)).toBe('→ Main T4 · Ben → Cara · 2 × Beer');
  });

  it('is counted but not added to what came off bills', () => {
    expect(billEventsTotals([move])).toEqual({ count: 1, amount: 0 });
  });
});
