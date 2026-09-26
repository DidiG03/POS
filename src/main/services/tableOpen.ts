import { prisma } from '@db/client';
import { coreServices, withTableLock } from './core';
import { broadcastTableStatusChanged } from './realtime';
import { seatCoveringReservationForOpenTable } from './reservations';

export type SetTableOpenOptions = {
  /** When true, skip SSE/IPC fan-out (rare — caller broadcasts separately). */
  skipBroadcast?: boolean;
  /**
   * Waiter tap time. Older than the last open/close that landed means this
   * request lost the race (usually a slow `open: true` after Pay).
   */
  intentAt?: number | null;
};

/**
 * Apply the full table open/close side effects for one table. Must run
 * under `withTableLock(area, label, …)` so concurrent sends / transfers /
 * closes cannot interleave half-updates on the same sitting.
 *
 * Occupancy is one `TableOccupancy` row; a repeated open keeps `openedAt`.
 *
 * Both Electron IPC (`tables:setOpen`) and the LAN HTTP API (`POST
 * `/tables/open`) call through here so tablets and laptops stay in sync.
 */
export async function applyTableOpenState(
  area: string,
  label: string,
  open: boolean,
  options?: SetTableOpenOptions,
): Promise<boolean> {
  const applied = await coreServices.setTableOpen(area, label, open, {
    intentAt: options?.intentAt,
  });
  // Stale open/close: do not broadcast, or every till paints a table red
  // that the host deliberately left free.
  if (!applied) return false;

  if (!open) {
    try {
      const active = await (prisma as any).kdsOrder.findFirst({
        where: { area, tableLabel: label, closedAt: null },
        orderBy: { openedAt: 'desc' },
      });
      if (active) {
        await (prisma as any).kdsOrder.update({
          where: { id: active.id },
          data: { closedAt: new Date() },
        });
      }
    } catch {
      // ignore if KDS tables are not migrated yet
    }
  }

  if (open) {
    await seatCoveringReservationForOpenTable(area, label);
  }

  if (!options?.skipBroadcast) {
    try {
      broadcastTableStatusChanged({ area, label, open });
    } catch {
      // best-effort — must not roll back the DB write
    }
  }
  return true;
}

/** Serialized entry point for every open/close from IPC or LAN API. */
export async function setTableOpenWithSideEffects(
  area: string,
  label: string,
  open: boolean,
  options?: SetTableOpenOptions,
): Promise<boolean> {
  if (!area || !label) return false;
  return withTableLock(area, label, async () => {
    // A stale open/close is settled: returning false made tablets retry it
    // forever. The row is simply left as the newer write set it.
    await applyTableOpenState(area, label, open, options);
    return true;
  });
}

/**
 * Call only while already holding `withTableLock(area, label)`.
 *
 * Waiter phones used to open the table in a separate LAN round-trip before
 * `tickets.log`. On a slow Wi-Fi that open was budget-handed-off or raced the
 * ticket write, and the host answered TABLE_CLOSED even though the waiter was
 * actively sending. Opening here (inside the same lock as the TicketLog write)
 * makes Send work regardless of whether the client remembered to open first.
 *
 * Idempotent TicketLog replays still short-circuit on `idempotencyKey` *before*
 * this runs, so a duplicate delivery after pay cannot resurrect occupancy.
 */
export async function ensureOccupiedForTicketWrite(
  area: string,
  label: string,
): Promise<void> {
  if (!area || !label) return;
  const open = await coreServices.isTableOpen(area, label);
  if (open) return;
  await applyTableOpenState(area, label, true);
}
