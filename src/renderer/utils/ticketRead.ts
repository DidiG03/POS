import type { FloorSnapshot } from '@shared/ipc';
import { asTicketLogItems } from '@shared/ticketLogItems';
import {
  cacheLatestTicket,
  ingestFloorSnapshot,
  invalidateTicketCache,
  peekFloorSnapshot,
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
    fetchFloor: async (area) => {
      const cached = peekFloorSnapshot(String(area || ''));
      if (cached) return cached;
      return readFloorSnapshot(area);
    },
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
  opts?: { ingest?: boolean },
): { items: TicketReadItems; note: string } | null {
  if (!snap || typeof snap !== 'object') return null;
  const tables = (snap as FloorSnapshot).tables;
  if (!Array.isArray(tables)) return null;
  if (opts?.ingest !== false) {
    ingestFloorSnapshot(snap as FloorSnapshot, {
      mergeOpen: Boolean(area),
      area,
    });
  }
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
    // The floor we just left already has this sitting. Parsing that whole
    // snapshot again on a phone (then writing it to localStorage) is what
    // froze the menu for tens of seconds after tapping a table.
    const cachedFloor = peekFloorSnapshot(area);
    if (cachedFloor) {
      const fromFloor = itemsFromFloorSnapshot(cachedFloor, area, label, {
        ingest: false,
      });
      if (fromFloor) return { ok: true, ...fromFloor };
      // Floor snapshots intentionally contain occupancy-only rows with
      // `items: []`. That is not proof that the open table has no ticket;
      // continue to a fresh snapshot before returning an empty bill.
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

/**
 * Live bill for an occupied table.
 *
 * Floor polls deliberately ship `items: []` (total only) for waiter-UI
 * perf — so peeks often miss even when the till already has lines. Callers
 * that open an occupied table must use this (or {@link readTicketForTable})
 * instead of trusting the floor row alone.
 */
export async function loadOpenTableBill(
  area: string,
  label: string,
  deps: TicketReadDeps = defaultDeps(),
): Promise<{ items: TicketReadItems; note: string } | null> {
  const read = await readTicketForTable(area, label, deps);
  if (!read.ok) return null;
  const live = read.items.filter((it) => it && it.voided !== true);
  if (!live.length) return null;
  return { items: read.items, note: read.note };
}
