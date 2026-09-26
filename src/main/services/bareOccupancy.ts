/**
 * A table can be marked occupied — red on the floor, timer running —
 * without a ticket and without a guest count. That is what waiters see
 * when a slow or replayed `tables.setOpen(true)` lands after the sitting
 * was already paid and closed: `openedAt` exists, and every session-scoped
 * read (items, owner, covers) comes back null.
 *
 * Covers-only sits stay. So does anything young enough that open-and-send
 * has not written the ticket yet.
 */
import { prisma } from '@db/client';
import { rowIsInOpenSession } from '@shared/ticketLogItems';
import { listOccupiedTables, setTableOccupied } from './tableOccupancy';
import { findLatestTicketLogForCurrentSession } from './tableSession';

/** Long enough for open → covers → ticket on a slow LAN. */
export const BARE_OCCUPANCY_GRACE_MS = 15_000;

const HEAL_INTERVAL_MS = 5_000;
let lastHealAt = 0;

export function resetBareOccupancyHealForTests(): void {
  lastHealAt = 0;
}

export function isBareOccupancy(opts: {
  openedAtMs: number;
  now: number;
  hasSessionTicket: boolean;
  hasSessionCovers: boolean;
  graceMs?: number;
}): boolean {
  if (opts.hasSessionTicket || opts.hasSessionCovers) return false;
  if (!Number.isFinite(opts.openedAtMs)) return false;
  const grace = opts.graceMs ?? BARE_OCCUPANCY_GRACE_MS;
  return opts.now - opts.openedAtMs >= grace;
}

async function sessionHasCovers(
  area: string,
  label: string,
  openedAtMs: number,
): Promise<boolean> {
  const recent = await prisma.covers
    .findMany({
      where: { area, label },
      orderBy: { id: 'desc' },
      take: 20,
    })
    .catch(() => []);
  return recent.some(
    (row: { createdAt: unknown; covers?: number | null }) =>
      Number(row.covers) > 0 && rowIsInOpenSession(row.createdAt, openedAtMs),
  );
}

/**
 * Close occupied tables whose sitting never received a ticket or a guest
 * count. Returns the tables that were freed.
 *
 * Pass `occupied` when the caller already loaded the floor so this does
 * not issue a second occupancy read.
 */
export async function releaseBareOccupancy(
  now = Date.now(),
  occupied?: Array<{ area: string; label: string; openedAt: Date }>,
): Promise<Array<{ area: string; label: string }>> {
  if (now - lastHealAt < HEAL_INTERVAL_MS) return [];
  lastHealAt = now;

  const tables = occupied ?? (await listOccupiedTables().catch(() => []));
  const closed: Array<{ area: string; label: string }> = [];
  for (const table of tables) {
    const openedAtMs = table.openedAt.getTime();
    if (!Number.isFinite(openedAtMs)) continue;
    if (now - openedAtMs < BARE_OCCUPANCY_GRACE_MS) continue;

    let hasTicket = true;
    try {
      const ticket = await findLatestTicketLogForCurrentSession(
        table.area,
        table.label,
      );
      hasTicket = Boolean(ticket);
    } catch {
      // Can't tell — leave the sitting alone.
      continue;
    }
    let hasCovers = true;
    try {
      hasCovers = await sessionHasCovers(table.area, table.label, openedAtMs);
    } catch {
      continue;
    }
    if (
      !isBareOccupancy({
        openedAtMs,
        now,
        hasSessionTicket: hasTicket,
        hasSessionCovers: hasCovers,
      })
    ) {
      continue;
    }
    const applied = await setTableOccupied(table.area, table.label, false);
    if (!applied) continue;
    closed.push({ area: table.area, label: table.label });
  }

  if (closed.length > 0) {
    try {
      const { broadcastTableStatusChanged } = await import('./realtime');
      for (const table of closed) {
        broadcastTableStatusChanged({
          area: table.area,
          label: table.label,
          open: false,
        });
      }
    } catch {
      // The row is already gone; the next floor poll paints it free.
    }
  }
  return closed;
}
