import type { Prisma, PrismaClient } from '@prisma/client';
import {
  consumeUnits,
  STORE_LOW_STOCK_AT,
  storeOnHandWrite,
  type StockConsumeLine,
} from '@shared/menuStock';

export type { StockConsumeLine };
export {
  consumeUnits,
  inventoryLevelFromOnHand,
  stockLinesFromTicketItems,
  storeOnHandWrite,
  STORE_LOW_STOCK_AT,
} from '@shared/menuStock';

type DbClient = PrismaClient | Prisma.TransactionClient;

export type StockConsumeMode = 'daily' | 'onHand';

/** Host-local calendar date (midnight boundary for daily stock reset). */
export function localCalendarDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * LOW / OUT from previous calendar days expire back to OK at the start of a new local day.
 * Store on-hand counts never set stockDay, so they are left alone.
 */
export async function expireStaleMenuStock(db: DbClient): Promise<void> {
  const today = localCalendarDateKey();
  await db.menuItem.updateMany({
    where: {
      stockDay: { not: null },
      NOT: { stockDay: today },
    },
    data: {
      stockLevel: 'OK',
      stockRemaining: null,
      stockDay: null,
    },
  });
}

/**
 * A Send asked for more of an item than the kitchen has left today.
 * Thrown inside the Send transaction, so the bill write rolls back with it.
 */
export class OutOfStockError extends Error {
  readonly code = 'OUT_OF_STOCK';
  constructor(
    readonly item: { sku: string; name: string },
    /** Units still available (0 = sold out). */
    readonly remaining: number,
    readonly requested: number,
  ) {
    super(
      remaining <= 0
        ? `${item.name} is sold out.`
        : `Only ${remaining} ${item.name} left (${requested} ordered). Lower the quantity and send again.`,
    );
    this.name = 'OutOfStockError';
  }
}

/** Sold out or low for today (yesterday's 86 no longer counts). */
function dailyStockApplies(row: { stockDay?: string | null }, today: string) {
  return !row.stockDay || row.stockDay === today;
}

/**
 * Take counted stock for a Send.
 * `daily` = restaurant 86ing (LOW count / OUT, midnight reset). An item that
 *   is OUT, or LOW with fewer units left than the Send asks for, refuses the
 *   whole Send with `OutOfStockError`; the count only goes down when every
 *   unit fits, in one conditional update, so ten parallel Sends of an item
 *   with three left take exactly three.
 * `onHand` = store inventory (any item with a remaining count). Shop counts
 *   drift from the shelf, so they never refuse a sale.
 */
export async function consumeMenuStockForTicketLines(
  db: DbClient,
  lines: StockConsumeLine[],
  mode: StockConsumeMode = 'daily',
): Promise<void> {
  if (!Array.isArray(lines) || !lines.length) return;

  const today = localCalendarDateKey();

  // One line per item, so "2 + 2 Ribeye" in one Send is checked as 4.
  const merged = new Map<string, number>();
  for (const line of lines) {
    const sku = String(line?.sku || '').trim();
    if (!sku) continue;
    merged.set(sku, (merged.get(sku) ?? 0) + consumeUnits(line?.qty));
  }

  for (const [sku, units] of merged) {
    const row = await db.menuItem.findUnique({ where: { sku } });
    if (!row) continue;

    if (mode === 'daily') {
      if (!dailyStockApplies(row as any, today)) continue;
      const level = String(row.stockLevel);
      if (level === 'OUT') {
        throw new OutOfStockError(
          { sku, name: String(row.name || sku) },
          0,
          units,
        );
      }
      if (level !== 'LOW' || row.stockRemaining == null) continue;
      // Atomic: only take the units when they are all there.
      const taken = await db.menuItem.updateMany({
        where: { id: row.id, stockRemaining: { gte: units } },
        data: { stockRemaining: { decrement: units } },
      });
      if (!taken.count) {
        const now = await db.menuItem.findUnique({ where: { id: row.id } });
        throw new OutOfStockError(
          { sku, name: String(row.name || sku) },
          Math.max(0, Number(now?.stockRemaining ?? 0)),
          units,
        );
      }
    } else {
      if (row.stockRemaining == null) continue;
      // Atomic decrement so two overlapping Sends cannot both write the
      // same leftover count (5 and 5 becoming 4 instead of 3).
      await db.menuItem.updateMany({
        where: { id: row.id, stockRemaining: { not: null } },
        data: { stockRemaining: { decrement: units } },
      });
    }
    const after = await db.menuItem.findUnique({ where: { id: row.id } });
    if (!after || after.stockRemaining == null) continue;
    const remaining = Math.max(0, Number(after.stockRemaining));
    if (mode === 'onHand') {
      await db.menuItem.update({
        where: { id: row.id },
        data: storeOnHandWrite(remaining),
      });
      continue;
    }

    if (remaining <= 0) {
      await db.menuItem.update({
        where: { id: row.id },
        data: {
          stockLevel: 'OUT',
          stockRemaining: 0,
          stockDay: today,
        },
      });
    } else if (remaining !== Number(after.stockRemaining)) {
      await db.menuItem.update({
        where: { id: row.id },
        data: { stockRemaining: remaining },
      });
    }
  }
}

/**
 * Put today's counted kitchen stock back for lines voided before they were
 * paid: the dish was never served. Only items still counted today (LOW with
 * a count, or OUT after the count ran out) change; an OUT that was set by
 * hand without a count stays OUT.
 */
export async function restoreDailyStockForLines(
  db: DbClient,
  lines: StockConsumeLine[],
): Promise<void> {
  const today = localCalendarDateKey();
  for (const line of Array.isArray(lines) ? lines : []) {
    const sku = String(line?.sku || '').trim();
    if (!sku) continue;
    const row = await db.menuItem.findUnique({ where: { sku } });
    if (!row || row.stockRemaining == null) continue;
    if (!dailyStockApplies(row as any, today)) continue;
    const level = String(row.stockLevel);
    if (level !== 'LOW' && level !== 'OUT') continue;
    const units = consumeUnits(line?.qty);
    await db.menuItem.updateMany({
      where: { id: row.id, stockRemaining: { not: null } },
      data: {
        stockRemaining: { increment: units },
        stockLevel: 'LOW',
        stockDay: today,
      },
    });
  }
}

/**
 * Put store stock back for lines of a sale that was voided or corrected:
 * the goods never left the shop. Only items that keep an on-hand count.
 * Units are counted the same way the sale took them (`consumeUnits`).
 */
export async function restockMenuStockForLines(
  db: DbClient,
  lines: StockConsumeLine[],
): Promise<number> {
  let restocked = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const sku = String(line?.sku || '').trim();
    if (!sku) continue;
    const row = await db.menuItem.findUnique({ where: { sku } });
    if (!row || row.stockRemaining == null) continue;
    const units = consumeUnits(line?.qty);
    await db.menuItem.updateMany({
      where: { id: row.id, stockRemaining: { not: null } },
      data: { stockRemaining: { increment: units } },
    });
    const after = await db.menuItem.findUnique({ where: { id: row.id } });
    if (!after || after.stockRemaining == null) continue;
    await db.menuItem.update({
      where: { id: row.id },
      data: storeOnHandWrite(Number(after.stockRemaining)),
    });
    restocked += units;
  }
  return restocked;
}

export function applyDailyStockPatch(input: {
  nextLevel: 'OK' | 'LOW' | 'OUT';
  stockRemainingIn?: number | null;
  existingRemaining: number | null;
  today: string;
}): {
  stockLevel: 'OK' | 'LOW' | 'OUT';
  stockRemaining: number | null;
  stockDay: string | null;
} {
  if (input.nextLevel === 'OK') {
    return { stockLevel: 'OK', stockRemaining: null, stockDay: null };
  }
  if (input.nextLevel === 'OUT') {
    return { stockLevel: 'OUT', stockRemaining: null, stockDay: input.today };
  }
  let rem: number | null = null;
  if (input.stockRemainingIn !== undefined && input.stockRemainingIn !== null) {
    rem = Math.floor(Number(input.stockRemainingIn));
  } else if (input.existingRemaining != null) {
    rem = input.existingRemaining;
  }
  if (rem == null || rem < 1) {
    throw new Error(
      'Low stock requires “how many left” as a whole number ≥ 1.',
    );
  }
  return { stockLevel: 'LOW', stockRemaining: rem, stockDay: input.today };
}

export function applyOnHandStockPatch(input: {
  stockLevelIn?: 'OK' | 'LOW' | 'OUT';
  stockRemainingIn?: number | null;
  existingRemaining: number | null;
}): {
  stockLevel: 'OK' | 'LOW' | 'OUT';
  stockRemaining: number | null;
  stockDay: null;
} {
  if (input.stockRemainingIn !== undefined && input.stockRemainingIn !== null) {
    return storeOnHandWrite(input.stockRemainingIn);
  }
  if (input.stockRemainingIn === null) {
    return { stockLevel: 'OK', stockRemaining: null, stockDay: null };
  }
  if (input.stockLevelIn === 'OUT') {
    return storeOnHandWrite(0);
  }
  if (input.stockLevelIn === 'OK') {
    if (input.existingRemaining != null) {
      return storeOnHandWrite(input.existingRemaining);
    }
    return { stockLevel: 'OK', stockRemaining: null, stockDay: null };
  }
  if (input.stockLevelIn === 'LOW') {
    const rem =
      input.existingRemaining != null && input.existingRemaining > 0
        ? input.existingRemaining
        : STORE_LOW_STOCK_AT;
    return storeOnHandWrite(rem);
  }
  return storeOnHandWrite(input.existingRemaining ?? 0);
}

/**
 * Menu items running low right now, for the Admin overview: LOW today (or
 * a shop's counted LOW). The overview used to count an unused inventory
 * table and always said 0.
 */
export async function countLowStockMenuItems(db: DbClient): Promise<number> {
  const today = localCalendarDateKey();
  return db.menuItem
    .count({
      where: {
        active: true,
        stockLevel: 'LOW',
        OR: [{ stockDay: null }, { stockDay: today }],
      } as any,
    })
    .catch(() => 0);
}
