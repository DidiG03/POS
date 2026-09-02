import { prisma } from '@db/client';

/** Lower bound for `(area, label)` rows tied to the current POS session. */
export async function getTableSessionStartedAt(
  area: string,
  label: string,
): Promise<Date | null> {
  const openAtRow = await prisma.syncState
    .findUnique({ where: { key: 'tables:openAt' } })
    .catch(() => null);
  const openAtMap = ((openAtRow?.valueJson as any) || {}) as Record<
    string,
    string
  >;
  const openAtIso = openAtMap[`${area}:${label}`];
  if (!openAtIso) return null;
  const sessionStart = new Date(openAtIso);
  if (Number.isNaN(sessionStart.getTime())) return null;
  return sessionStart;
}

/**
 * Stable identifier for one dining session at `(area, label)`.
 *
 * TicketLog rows are cumulative snapshots — every "send to kitchen" stores the
 * whole ticket again — so reports have to know which rows belong to the same
 * sitting. The session start timestamp is already tracked in `tables:openAt`
 * and a table cannot be re-seated without that value changing, which makes it
 * the natural grouping key. See `latestRowPerSession` in `@shared/ticketRevenue`.
 */
export function buildTableSessionKey(
  area: string,
  label: string,
  startedAtIso: string,
): string {
  return `${area}\u0000${label}\u0000${startedAtIso}`;
}

/**
 * Session key for the table's current open session, or `null` when the table
 * has no `tables:openAt` entry to bound it (rows then fall back to the
 * snapshot-shape heuristic in `latestRowPerSession`).
 */
export async function getCurrentTableSessionKey(
  area: string,
  label: string,
): Promise<string | null> {
  const startedAt = await getTableSessionStartedAt(area, label);
  if (!startedAt) return null;
  return buildTableSessionKey(area, label, startedAt.toISOString());
}

/**
 * Returns the userId of the waiter who owns the CURRENT open session
 * for `(area, tableLabel)`, or `null` if either:
 *   - the table has no `tables:openAt` entry (can't bound the session), or
 *   - no `ticketLog` rows exist within the current session window.
 */
export async function getCurrentSessionOwnerId(
  area: string,
  tableLabel: string,
): Promise<number | null> {
  const sessionStart = await getTableSessionStartedAt(area, tableLabel);
  if (!sessionStart) return null;
  const last = await prisma.ticketLog
    .findFirst({
      where: {
        area,
        tableLabel,
        createdAt: { gte: sessionStart },
      },
      orderBy: { createdAt: 'desc' },
      select: { userId: true },
    })
    .catch(() => null);
  return last ? Number(last.userId) : null;
}
