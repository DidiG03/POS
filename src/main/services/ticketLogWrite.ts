/**
 * Write one ticket snapshot (a Send) and count down low stock, together.
 *
 * Both the till (`tickets:log`) and phones (`POST /tickets`) write through
 * here. The phone route used to write the TicketLog on its own and ignore
 * `stockConsumeLines`, so counted LOW stock only went down for orders taken
 * at the till — and phones are where most orders are taken.
 *
 * The row and the stock change share one transaction: a replayed Send with
 * the same idempotency key fails on the unique key and rolls back, so stock
 * is counted once per real Send.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@db/client';
import { consumeMenuStockForTicketLines } from './menuStock';
import { storePlanBlocksTables } from './license';

export type StockConsumeInput = { sku?: string; qty?: number };

/** Keep only well-formed `{ sku, qty }` lines from a client payload. */
export function stockLinesFromPayload(raw: unknown): StockConsumeInput[] {
  if (!Array.isArray(raw)) return [];
  const out: StockConsumeInput[] = [];
  for (const line of raw.slice(0, 500)) {
    const sku = String((line as any)?.sku ?? '').trim();
    if (!sku) continue;
    const qty = Number((line as any)?.qty);
    out.push({ sku, qty: Number.isFinite(qty) ? qty : 1 });
  }
  return out;
}

/**
 * Returns `'written'` for a new row, `'duplicate'` when a Send with this
 * idempotency key was already recorded (nothing changes).
 */
export async function writeTicketSnapshot(input: {
  userId: number;
  area: string;
  tableLabel: string;
  covers: number | null;
  items: unknown[];
  note: string | null;
  idempotencyKey?: string | null;
  sessionKey?: string | null;
  stockConsumeLines?: StockConsumeInput[];
}): Promise<'written' | 'duplicate'> {
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.ticketLog.create({
        data: {
          userId: Number(input.userId),
          area: input.area,
          tableLabel: input.tableLabel,
          covers: input.covers,
          itemsJson: (input.items ?? []) as any,
          note: input.note,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        } as any,
      });
      await consumeMenuStockForTicketLines(
        tx,
        input.stockConsumeLines ?? [],
        storePlanBlocksTables() ? 'onHand' : 'daily',
      );
    });
  } catch (e: any) {
    if (e?.code === 'P2002' && idempotencyKey) return 'duplicate';
    throw e;
  }
  return 'written';
}
