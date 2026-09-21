import { prisma } from '@db/client';
import {
  rowIsInOpenSession,
  ticketLogCreatedAtMs,
} from '@shared/ticketLogItems';
import { getOpenedAt } from './tableOccupancy';

/** Lower bound for `(area, label)` rows tied to the current POS session. */
export async function getTableSessionStartedAt(
  area: string,
  label: string,
): Promise<Date | null> {
  return getOpenedAt(area, label);
}

/**
 * Stable identifier for one dining session at `(area, label)`.
 *
 * TicketLog rows are cumulative snapshots — every "send to kitchen" stores the
 * whole ticket again — so reports have to know which rows belong to the same
 * sitting. The session start timestamp is already tracked in occupancy
 * (`TableOccupancy.openedAt`) and a table cannot be re-seated without that
 * value changing, which makes it the natural grouping key. See
 * `latestRowPerSession` in `@shared/ticketRevenue`.
 */
/**
 * Unit Separator. A NUL (`\u0000`) used to be the delimiter; libSQL/SQLite
 * TEXT truncated at the first NUL, so every sitting in Salla stored the key
 * `"Salla"` and Admin collapsed the whole room into one ticket.
 */
export const TABLE_SESSION_KEY_SEP = '\u001f';

export function buildTableSessionKey(
  area: string,
  label: string,
  startedAtIso: string,
): string {
  return `${area}${TABLE_SESSION_KEY_SEP}${label}${TABLE_SESSION_KEY_SEP}${startedAtIso}`;
}

/**
 * Session key for the table's current open session, or `null` when the table
 * has no occupancy row to bound it (rows then fall back to the
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
 * Newest TicketLog in `rows` for the current sitting.
 *
 * Rows must already be newest-`id`-first. Auto-increment `id` is the only
 * monotonic order on this table: SQLite DateTime is mixed ISO text and
 * epoch ms, so `ORDER BY createdAt DESC` can hide the live bill behind
 * older rows and the waiter sees an empty ticket on an occupied table.
 *
 * Covers already look up this way (`orderBy: { id: 'desc' }`). Tickets
 * did not — which is why guest count and elapsed time survived while
 * the items disappeared.
 */
export function pickLatestSessionTicket<
  T extends { id: number; createdAt: unknown },
>(rowsNewestIdFirst: T[], sessionStartMs: number | null): T | null {
  if (rowsNewestIdFirst.length === 0) {
    return null;
  }
  const newest = rowsNewestIdFirst[0];
  if (sessionStartMs == null) {
    return newest;
  }
  const inSession = rowsNewestIdFirst.find((row) =>
    rowIsInOpenSession(row.createdAt, sessionStartMs),
  );
  if (inSession) {
    return inSession;
  }
  // Occupied sitting whose DateTime we cannot parse: the newest id is
  // still this table's live bill.
  if (!Number.isFinite(ticketLogCreatedAtMs(newest.createdAt))) {
    return newest;
  }
  return null;
}

/**
 * Newest TicketLog at `(area, tableLabel)`, optionally bounded by the
 * sitting's occupancy `openedAt`. Recency is `id`, session membership is
 * decided in JS so mixed SQLite DateTime storage cannot hide the bill.
 */
export async function findLatestTicketLogSince(
  area: string,
  tableLabel: string,
  since: Date | null,
) {
  const recent = await prisma.ticketLog.findMany({
    where: { area, tableLabel },
    orderBy: { id: 'desc' },
    take: 40,
  });
  // Prisma client is typed as `any` in this process; pin the row through so
  // callers still see `itemsJson` / `note` / `userId`.
  return pickLatestSessionTicket(
    recent as Array<{ id: number; createdAt: unknown }>,
    since ? since.getTime() : null,
  ) as (typeof recent)[number] | null;
}

/**
 * Latest TicketLog for the current sitting only. Returns null when the
 * table is not open (no occupancy row) so callers cannot mutate the
 * previous paid-out ticket after a reopen.
 */
export async function findLatestTicketLogForCurrentSession(
  area: string,
  tableLabel: string,
) {
  const sessionStart = await getTableSessionStartedAt(area, tableLabel);
  if (!sessionStart) {
    return null;
  }
  return findLatestTicketLogSince(area, tableLabel, sessionStart);
}

/**
 * Returns the userId of the waiter who owns the CURRENT open session
 * for `(area, tableLabel)`, or `null` if either:
 *   - the table has no occupancy row (can't bound the session), or
 *   - no `ticketLog` rows exist within the current session window.
 */
export async function getCurrentSessionOwnerId(
  area: string,
  tableLabel: string,
): Promise<number | null> {
  const last = await findLatestTicketLogForCurrentSession(area, tableLabel);
  return last ? Number(last.userId) : null;
}
