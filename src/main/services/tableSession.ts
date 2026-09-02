import { prisma } from '@db/client';
import { tableKey } from '@shared/utils/tableKey';

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
  const openAtIso = openAtMap[tableKey(area, label)];
  if (!openAtIso) return null;
  const sessionStart = new Date(openAtIso);
  if (Number.isNaN(sessionStart.getTime())) return null;
  return sessionStart;
}

/**
 * Latest TicketLog for the current sitting only. Returns null when the
 * table is not open (no `tables:openAt`) so callers cannot mutate the
 * previous paid-out ticket after a reopen.
 */
export async function findLatestTicketLogForCurrentSession(
  area: string,
  tableLabel: string,
) {
  const sessionStart = await getTableSessionStartedAt(area, tableLabel);
  if (!sessionStart) return null;
  return prisma.ticketLog.findFirst({
    where: { area, tableLabel, createdAt: { gte: sessionStart } },
    orderBy: { createdAt: 'desc' },
  });
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
