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
