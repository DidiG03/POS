/**
 * The guest count of a table's current sitting, for the ticket header and
 * the Pay gate (`covers:getLast`, `GET /covers/last`).
 *
 * Covers are stored twice: by the covers dialog (`Covers` rows) and on the
 * bill with every Send (`TicketLog.covers`), which reports read. A sitting
 * whose count only came with the order (another device, a script, a Send
 * replayed from the offline queue) had no `Covers` row, so the ticket showed
 * "—" while reports showed 2. The bill's count is now the fallback.
 */
import { prisma } from '@db/client';
import { rowIsInOpenSession } from '@shared/ticketLogItems';
import {
  findLatestTicketLogForCurrentSession,
  getTableSessionStartedAt,
} from './tableSession';

function positive(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

export async function currentSittingCovers(
  area: string,
  label: string,
): Promise<number | null> {
  // Scope to the current sitting. An unoccupied table has no guest count.
  const sessionStart = await getTableSessionStartedAt(area, label);
  if (!sessionStart) return null;
  const sqlHit = await prisma.covers
    .findFirst({
      where: { area, label, createdAt: { gte: sessionStart } },
      orderBy: { id: 'desc' },
    })
    .catch(() => null);
  let saved = sqlHit ? positive(sqlHit.covers) : null;
  if (!sqlHit) {
    const recent = (await prisma.covers
      .findMany({ where: { area, label }, orderBy: { id: 'desc' }, take: 20 })
      .catch(() => [])) as Array<{ createdAt: Date; covers?: number | null }>;
    const row = recent.find((r) =>
      rowIsInOpenSession(r.createdAt, sessionStart.getTime()),
    );
    saved = row ? positive(row.covers) : null;
  }
  if (saved != null) return saved;
  const bill = await findLatestTicketLogForCurrentSession(area, label).catch(
    () => null,
  );
  return bill ? positive((bill as any).covers) : null;
}
