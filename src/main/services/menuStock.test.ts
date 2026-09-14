import { describe, expect, it } from 'vitest';
import {
  applyDailyStockPatch,
  applyOnHandStockPatch,
  consumeMenuStockForTicketLines,
} from './menuStock';

describe('applyOnHandStockPatch', () => {
  it('derives level from the typed on-hand count', () => {
    expect(
      applyOnHandStockPatch({ stockRemainingIn: 20, existingRemaining: null }),
    ).toEqual({
      stockLevel: 'OK',
      stockRemaining: 20,
      stockDay: null,
    });
    expect(
      applyOnHandStockPatch({ stockRemainingIn: 0, existingRemaining: 9 }),
    ).toEqual({
      stockLevel: 'OUT',
      stockRemaining: 0,
      stockDay: null,
    });
  });

  it('does not wipe a count when marking in-stock', () => {
    expect(
      applyOnHandStockPatch({
        stockLevelIn: 'OK',
        existingRemaining: 18,
      }),
    ).toEqual({
      stockLevel: 'OK',
      stockRemaining: 18,
      stockDay: null,
    });
  });
});

describe('consumeMenuStockForTicketLines', () => {
  it('decrements remaining in SQL instead of writing a stale leftover', async () => {
    const remaining = { value: 5 };
    const db = {
      menuItem: {
        findUnique: async () => ({
          id: 1,
          sku: 'CEZAR',
          stockRemaining: remaining.value,
          stockLevel: 'LOW',
        }),
        updateMany: async ({ data }: any) => {
          remaining.value -= Number(data.stockRemaining.decrement);
          return { count: 1 };
        },
        update: async ({ data }: any) => {
          if (data.stockRemaining != null)
            remaining.value = data.stockRemaining;
          return {};
        },
      },
    };
    await consumeMenuStockForTicketLines(
      db as any,
      [{ sku: 'CEZAR', qty: 2 }],
      'daily',
    );
    expect(remaining.value).toBe(3);
  });
});

describe('applyDailyStockPatch', () => {
  it('clears remaining when the restaurant marks in-stock', () => {
    expect(
      applyDailyStockPatch({
        nextLevel: 'OK',
        existingRemaining: 4,
        today: '2026-09-10',
      }),
    ).toEqual({
      stockLevel: 'OK',
      stockRemaining: null,
      stockDay: null,
    });
  });
});
