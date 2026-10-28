import { describe, expect, it } from 'vitest';
import {
  OutOfStockError,
  consumeMenuStockForTicketLines,
  localCalendarDateKey,
  restoreDailyStockForLines,
} from './menuStock';

/** In-memory menuItem table whose writes yield, like a real database. */
function fakeDb(row: Record<string, any>) {
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  const matches = (where: any) => {
    if (where.id !== undefined && where.id !== row.id) return false;
    if (where.sku !== undefined && where.sku !== row.sku) return false;
    const rem = where.stockRemaining;
    if (rem?.gte !== undefined && !(row.stockRemaining >= rem.gte))
      return false;
    if (rem?.not === null && row.stockRemaining == null) return false;
    return true;
  };
  const apply = (data: any) => {
    for (const [k, v] of Object.entries<any>(data)) {
      if (v && typeof v === 'object' && 'decrement' in v)
        row[k] = row[k] - v.decrement;
      else if (v && typeof v === 'object' && 'increment' in v)
        row[k] = row[k] + v.increment;
      else row[k] = v;
    }
  };
  return {
    row,
    menuItem: {
      findUnique: async ({ where }: any) => {
        await tick();
        return matches(where) ? { ...row } : null;
      },
      // Check-and-write in one step, as one SQL UPDATE … WHERE is.
      updateMany: async ({ where, data }: any) => {
        await tick();
        if (!matches(where)) return { count: 0 };
        apply(data);
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        await tick();
        apply(data);
        return { ...row };
      },
    },
  } as any;
}

const today = localCalendarDateKey();

describe('stock at Send', () => {
  it('ten parallel Sends of an item with 3 left take exactly 3', async () => {
    const db = fakeDb({
      id: 1,
      sku: 'RIB',
      name: 'Ribeye',
      stockLevel: 'LOW',
      stockRemaining: 3,
      stockDay: today,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        consumeMenuStockForTicketLines(db, [{ sku: 'RIB', qty: 1 }], 'daily'),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = results.filter((r) => r.status === 'rejected') as any[];
    expect(refused).toHaveLength(7);
    expect(refused[0].reason).toBeInstanceOf(OutOfStockError);
    expect(db.row.stockRemaining).toBe(0);
    expect(db.row.stockLevel).toBe('OUT');
  });

  it('refuses a Send after the item sold out', async () => {
    const db = fakeDb({
      id: 1,
      sku: 'RIB',
      name: 'Ribeye',
      stockLevel: 'OUT',
      stockRemaining: 0,
      stockDay: today,
    });
    await expect(
      consumeMenuStockForTicketLines(db, [{ sku: 'RIB', qty: 1 }], 'daily'),
    ).rejects.toThrow('Ribeye is sold out.');
  });

  it('refuses more than is left, and says how many are', async () => {
    const db = fakeDb({
      id: 1,
      sku: 'RIB',
      name: 'Ribeye',
      stockLevel: 'LOW',
      stockRemaining: 2,
      stockDay: today,
    });
    const err = await consumeMenuStockForTicketLines(
      db,
      [
        { sku: 'RIB', qty: 2 },
        { sku: 'RIB', qty: 1 },
      ],
      'daily',
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OutOfStockError);
    expect(err.remaining).toBe(2);
    expect(err.requested).toBe(3);
    expect(db.row.stockRemaining).toBe(2);
  });

  it("ignores yesterday's 86", async () => {
    const db = fakeDb({
      id: 1,
      sku: 'RIB',
      name: 'Ribeye',
      stockLevel: 'OUT',
      stockRemaining: 0,
      stockDay: '2000-01-01',
    });
    await expect(
      consumeMenuStockForTicketLines(db, [{ sku: 'RIB', qty: 1 }], 'daily'),
    ).resolves.toBeUndefined();
  });

  it('a void puts the units back and lifts a counted sell-out', async () => {
    const db = fakeDb({
      id: 1,
      sku: 'RIB',
      name: 'Ribeye',
      stockLevel: 'OUT',
      stockRemaining: 0,
      stockDay: today,
    });
    await restoreDailyStockForLines(db, [{ sku: 'RIB', qty: 2 }]);
    expect(db.row).toMatchObject({ stockLevel: 'LOW', stockRemaining: 2 });
  });

  it('a void leaves an uncounted item alone', async () => {
    const db = fakeDb({
      id: 1,
      sku: 'RIB',
      name: 'Ribeye',
      stockLevel: 'OUT',
      stockRemaining: null,
      stockDay: today,
    });
    await restoreDailyStockForLines(db, [{ sku: 'RIB', qty: 2 }]);
    expect(db.row).toMatchObject({ stockLevel: 'OUT', stockRemaining: null });
  });
});
