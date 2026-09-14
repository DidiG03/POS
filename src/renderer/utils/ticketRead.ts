/**
 * Ask the host what is on this table's bill right now.
 *
 * Empty is the expensive answer to get wrong: never take a cached `[]` as
 * truth, confirm against `getLatestForTable`, then fall back to the floor
 * snapshot (and any already-ingested cache) so Electron and tablets restore
 * the same sitting.
 */
import type { FloorSnapshot } from '@shared/ipc';
import { asTicketLogItems } from '@shared/ticketLogItems';
import {
  cacheLatestTicket,
  ingestFloorSnapshot,
  invalidateTicketCache,
  readFloorSnapshot,
} from './posReadCache';
import { peekTableBill } from './tableBill';

export type TicketReadItems = Array<Record<string, unknown>>;

export type TicketRead =
  | { ok: true; items: TicketReadItems; note: string }
  | { ok: false };

export type TicketReadDeps = {
  fetch: (area: string, label: string) => Promise<unknown>;
  invalidate: (area: string, label: string) => void;
  fetchFloor?: (area: string) => Promise<unknown>;
};

function defaultDeps(): TicketReadDeps {
  return {
    fetch: (area, label) =>
      (window as any).api.tickets.getLatestForTable(area, label),
    invalidate: invalidateTicketCache,
    fetchFloor: (area) => readFloorSnapshot(area),
  };
}

function itemsOf(latest: unknown): TicketReadItems {
  const items = (latest as { items?: unknown } | null | undefined)?.items;
  return asTicketLogItems(items) as TicketReadItems;
}

function noteOf(latest: unknown): string {
  const note = (latest as { note?: unknown } | null | undefined)?.note;
  return typeof note === 'string' ? note : '';
}

function rememberBill(
  area: string,
  label: string,
  latest: unknown,
  items: TicketReadItems,
): void {
  if (!items.length) return;
  const row = latest as
    | {
        note?: unknown;
        covers?: unknown;
        createdAt?: unknown;
        userId?: unknown;
      }
    | null
    | undefined;
  cacheLatestTicket(area, label, {
    items,
    note: noteOf(latest),
    covers: row?.covers,
    createdAt:
      typeof row?.createdAt === 'string'
        ? row.createdAt
        : new Date().toISOString(),
    userId: row?.userId,
  });
}

function itemsFromFloorSnapshot(
  snap: unknown,
  area: string,
  label: string,
): { items: TicketReadItems; note: string } | null {
  if (!snap || typeof snap !== 'object') return null;
  const tables = (snap as FloorSnapshot).tables;
  if (!Array.isArray(tables)) return null;
  ingestFloorSnapshot(snap as FloorSnapshot, {
    mergeOpen: Boolean(area),
    area,
  });
  const row = tables.find((t) => t && t.area === area && t.label === label);
  const items = asTicketLogItems(row?.items) as TicketReadItems;
  if (!items.length) return null;
  return { items, note: noteOf(row) };
}

export async function readTicketForTable(
  area: string,
  label: string,
  deps: TicketReadDeps = defaultDeps(),
): Promise<TicketRead> {
  let latest: unknown;
  try {
    latest = await deps.fetch(area, label);
  } catch {
    return { ok: false };
  }
  const items = itemsOf(latest);
  if (items.length > 0) {
    rememberBill(area, label, latest, items);
    return { ok: true, items, note: noteOf(latest) };
  }

  deps.invalidate(area, label);
  try {
    const confirmed = await deps.fetch(area, label);
    const confirmedItems = itemsOf(confirmed);
    if (confirmedItems.length > 0) {
      rememberBill(area, label, confirmed, confirmedItems);
      return { ok: true, items: confirmedItems, note: noteOf(confirmed) };
    }
    if (typeof deps.fetchFloor === 'function') {
      const snap = await deps.fetchFloor(area).catch(() => null);
      const fromFloor = itemsFromFloorSnapshot(snap, area, label);
      if (fromFloor) return { ok: true, ...fromFloor };
    }
    const peeked = peekTableBill(area, label);
    if (peeked) return { ok: true, ...peeked };
    return { ok: true, items: confirmedItems, note: noteOf(confirmed) };
  } catch {
    return { ok: false };
  }
}
