import type { Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

/** Host-local calendar date (midnight boundary for daily stock reset). */
export function localCalendarDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * LOW / OUT from previous calendar days expire back to OK at the start of a new local day.
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

export type StockConsumeLine = { sku?: string; qty?: number };

/**
 * Decrement counted LOW stock when staged lines are sent to the kitchen.
 * Uses integer units: fractional qty (e.g. kg) consumes ceil(qty) portions.
 */
export async function consumeMenuStockForTicketLines(
  db: DbClient,
  lines: StockConsumeLine[],
): Promise<void> {
  if (!Array.isArray(lines) || !lines.length) return;

  const today = localCalendarDateKey();

  for (const line of lines) {
    const sku = String(line?.sku || '').trim();
    if (!sku) continue;

    const rawQty = Number(line?.qty ?? 1);
    const units = Number.isFinite(rawQty) && rawQty > 0 ? Math.ceil(rawQty) : 1;

    const row = await db.menuItem.findUnique({ where: { sku } });
    if (!row) continue;

    if (String(row.stockLevel) !== 'LOW') continue;
    if (row.stockRemaining == null) continue;

    const remaining = row.stockRemaining - units;
    if (remaining <= 0) {
      await db.menuItem.update({
        where: { id: row.id },
        data: {
          stockLevel: 'OUT',
          stockRemaining: 0,
          stockDay: today,
        },
      });
    } else {
      await db.menuItem.update({
        where: { id: row.id },
        data: { stockRemaining: remaining },
      });
    }
  }
}
