import { prisma } from '@db/client';
import { coreServices, withTableLock } from './core';
import { broadcastTableStatusChanged } from './realtime';

export type SetTableOpenOptions = {
  /** When true, skip SSE/IPC fan-out (rare — caller broadcasts separately). */
  skipBroadcast?: boolean;
};

/**
 * Apply the full table open/close side effects for one table. Must run
 * under `withTableLock(area, label, …)` so concurrent sends / transfers /
 * closes cannot interleave half-updates on `tables:open` and `tables:openAt`.
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

  const keyAt = 'tables:openAt';
  const atRow = await prisma.syncState.findUnique({ where: { key: keyAt } });
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const kKey = `${area}:${label}`;
  // IMPORTANT: do NOT reset openAt on repeated "open=true" calls.
  if (open) {
    if (!atMap[kKey]) atMap[kKey] = new Date().toISOString();
  } else {
    delete atMap[kKey];
  }
  await prisma.syncState.upsert({
    where: { key: keyAt },
    create: { key: keyAt, valueJson: atMap },
    update: { valueJson: atMap },
  });

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
