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
 * Decrement counted stock.
 * `daily` = restaurant 86ing (LOW only, midnight reset).
 * `onHand` = store inventory (any item with a remaining count).
 */
export async function consumeMenuStockForTicketLines(
  db: DbClient,
  lines: StockConsumeLine[],
  mode: StockConsumeMode = 'daily',
): Promise<void> {
  if (!Array.isArray(lines) || !lines.length) return;

  const today = localCalendarDateKey();

  for (const line of lines) {
    const sku = String(line?.sku || '').trim();
    if (!sku) continue;

    const units = consumeUnits(line?.qty);

    const row = await db.menuItem.findUnique({ where: { sku } });
    if (!row) continue;
    if (row.stockRemaining == null) continue;

    if (mode === 'daily' && String(row.stockLevel) !== 'LOW') continue;

    // Atomic decrement so two overlapping Sends cannot both write the
    // same leftover count (5 and 5 becoming 4 instead of 3).
    await db.menuItem.updateMany({
      where: { id: row.id, stockRemaining: { not: null } },
      data: { stockRemaining: { decrement: units } },
    });
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
