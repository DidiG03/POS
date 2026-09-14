import { prisma } from '@db/client';
import { coreServices, withTableLock } from './core';
import { broadcastTableStatusChanged } from './realtime';
import { seatCoveringReservationForOpenTable } from './reservations';

export type SetTableOpenOptions = {
  /** When true, skip SSE/IPC fan-out (rare — caller broadcasts separately). */
  skipBroadcast?: boolean;
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
): Promise<void> {
  await coreServices.setTableOpen(area, label, open);

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
    await applyTableOpenState(area, label, open, options);
    return true;
  });
}
