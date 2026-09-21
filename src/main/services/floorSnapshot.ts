/**
 * One-shot floor payload for waiter tablets.
 *
 * Occupancy rows once, then the latest TicketLog / Covers row per occupied
 * table (`MAX(id) GROUP BY`). Concurrent tablet polls share one in-flight
 * query so a rush does not stampede SQLite.
 */
import { prisma } from '@db/client';
import type { FloorSnapshot, FloorTableSnapshot } from '@shared/ipc';
import { coalesceInflight } from '@shared/asyncMutex';
import {
  asTicketLogItems,
  SESSION_START_SLACK_MS,
  ticketLogCreatedAtMs,
} from '@shared/ticketLogItems';
import { splitTableKey, tableKey } from '@shared/utils/tableKey';
import { stripTransferTagsFromNote } from '@shared/utils/transferNote';
import { listOccupiedTables } from './tableOccupancy';
import {
  asPositiveId,
  latestCoverIdSelectSql,
  latestIdWhereSql,
  latestTicketIdSelectSql,
  mergeLatestIdRows,
  parseLatestIdRows,
  type TablePair,
} from './ticketLogLatest';

export type { FloorSnapshot, FloorTableSnapshot };

export function tableSessionKey(area: string, label: string): string {
  return tableKey(area, label);
}

export function ticketRunningTotal(
  items: Array<{ voided?: boolean; unitPrice?: number; qty?: number }>,
): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it?.voided) continue;
    total += Number(it?.unitPrice || 0) * Number(it?.qty || 1);
  }
  return total;
}

type DatedRow = {
  area: string;
  tableLabel: string;
  createdAt: Date | number | string;
  id?: number | string;
};

function rowIsNewerThan<T extends DatedRow>(row: T, prev: T): boolean {
  const rowId = asPositiveId(row.id);
  const prevId = asPositiveId(prev.id);
  if (rowId != null && prevId != null) return rowId > prevId;
  const rt = ticketLogCreatedAtMs(row.createdAt);
  const pt = ticketLogCreatedAtMs(prev.createdAt);
  if (Number.isFinite(rt) && Number.isFinite(pt)) return rt > pt;
  return Number.isFinite(rt) && !Number.isFinite(pt);
}

/**
 * Keep the newest row per table, ignoring anything written before that
 * table's current open session (`TableOccupancy.openedAt`).
 *
 * Unparseable DateTime is not "before the sitting" — dropping those rows
 * is how an occupied table's floor total went to 0 and the ticket panel
 * showed empty after a send.
 */
export function pickLatestPerTable<T extends DatedRow>(
  rows: T[],
  sinceMsByKey: Record<string, number | null>,
): Map<string, T> {
  const out = new Map<string, T>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = tableSessionKey(row.area, row.tableLabel);
    if (!(key in sinceMsByKey)) continue;
    const since = sinceMsByKey[key];
    const t = ticketLogCreatedAtMs(row.createdAt);
    if (
      since != null &&
      Number.isFinite(t) &&
      t < since - SESSION_START_SLACK_MS
    ) {
      continue;
    }
    const prev = out.get(key);
    if (!prev || rowIsNewerThan(row, prev)) out.set(key, row);
  }
  return out;
}

const TICKET_SNAP_SELECT = {
  id: true,
  area: true,
  tableLabel: true,
  createdAt: true,
  userId: true,
  itemsJson: true,
  note: true,
  covers: true,
} as const;

const COVER_SNAP_SELECT = {
  id: true,
  area: true,
  label: true,
  covers: true,
  createdAt: true,
} as const;

async function queryLatestIds(
  pairs: TablePair[],
  kind: 'ticket' | 'cover',
): Promise<number[]> {
  const clauses = latestIdWhereSql(
    pairs,
    kind === 'ticket' ? 'tableLabel' : 'label',
  );
  if (clauses.length === 0) return [];
  const chunks = await Promise.all(
    clauses.map(async (clause) => {
      const q =
        kind === 'ticket'
          ? latestTicketIdSelectSql(clause)
          : latestCoverIdSelectSql(clause);
      const rows = await prisma.$queryRawUnsafe(q.sql, ...q.params);
      return parseLatestIdRows(rows);
    }),
  );
  return mergeLatestIdRows(chunks).map((r) => r.id);
}

async function fetchLatestTicketSnapshots(pairs: TablePair[]) {
  try {
    const ids = await queryLatestIds(pairs, 'ticket');
    if (ids.length === 0) return [];
    return await prisma.ticketLog.findMany({
      where: { id: { in: ids } },
      select: TICKET_SNAP_SELECT,
    });
  } catch {
    return Promise.all(
      pairs.map((p) =>
        prisma.ticketLog.findFirst({
          where: { area: p.area, tableLabel: p.label },
          orderBy: { id: 'desc' },
          select: TICKET_SNAP_SELECT,
        }),
      ),
    ).then((rows) => rows.filter(Boolean));
  }
}

async function fetchLatestCoverSnapshots(pairs: TablePair[]) {
  try {
    const ids = await queryLatestIds(pairs, 'cover');
    if (ids.length === 0) return [];
    return await prisma.covers.findMany({
      where: { id: { in: ids } },
      select: COVER_SNAP_SELECT,
    });
  } catch {
    return Promise.all(
      pairs.map((p) =>
        prisma.covers.findFirst({
          where: { area: p.area, label: p.label },
          orderBy: { id: 'desc' },
          select: COVER_SNAP_SELECT,
        }),
      ),
    ).then((rows) => rows.filter(Boolean));
  }
}

/** Fresh enough for a floor paint; writes invalidate immediately. */
export const FLOOR_SNAPSHOT_TTL_MS = 300;
const FLOOR_SNAPSHOT_STALE_RETRIES = 3;

const floorInflight = new Map<string, Promise<FloorSnapshot>>();
const floorCache = new Map<string, { at: number; value: FloorSnapshot }>();
let floorGeneration = 0;

function dropFloorCache(area?: string): void {
  const want = String(area || '').trim();
  if (!want) {
    floorCache.clear();
    floorInflight.clear();
    return;
  }
  floorCache.delete(want);
  floorCache.delete('');
  floorInflight.delete(want || '*');
  floorInflight.delete('*');
}

export function invalidateFloorSnapshotCache(area?: string): void {
  floorGeneration += 1;
  dropFloorCache(area);
}

/** @internal vitest */
export function resetFloorSnapshotCacheForTests(): void {
  floorGeneration = 0;
  dropFloorCache();
}

export async function getFloorSnapshot(area?: string): Promise<FloorSnapshot> {
  const key = String(area || '').trim();
  const hit = floorCache.get(key);
  if (hit && Date.now() - hit.at < FLOOR_SNAPSHOT_TTL_MS) return hit.value;
  return coalesceInflight(floorInflight, key || '*', async () => {
    let snap: FloorSnapshot = { tables: [] };
    for (let i = 0; i < FLOOR_SNAPSHOT_STALE_RETRIES; i++) {
      const gen = floorGeneration;
      snap = await loadFloorSnapshot(key || undefined);
      if (gen !== floorGeneration) continue;
      floorCache.set(key, { at: Date.now(), value: snap });
      return snap;
    }
    return snap;
  });
}

async function loadFloorSnapshot(area?: string): Promise<FloorSnapshot> {
  const wantArea = String(area || '').trim();
  const occupied = await listOccupiedTables();
  const openKeys: string[] = [];
  const sinceMsByKey: Record<string, number | null> = {};
  const openedAtByKey: Record<string, string> = {};

  for (const t of occupied) {
    if (wantArea && t.area !== wantArea) continue;
    const k = tableSessionKey(t.area, t.label);
    openKeys.push(k);
    const ms = t.openedAt.getTime();
    sinceMsByKey[k] = Number.isFinite(ms) ? ms : null;
    openedAtByKey[k] = t.openedAt.toISOString();
  }

  if (openKeys.length === 0) return { tables: [] };

  const openPairs = openKeys
    .map((k) => splitTableKey(k))
    .filter((p): p is { area: string; label: string } => Boolean(p));
  const [ticketRows, coverRows] = await Promise.all([
    fetchLatestTicketSnapshots(openPairs),
    fetchLatestCoverSnapshots(openPairs),
  ]);

  type TicketSnapRow = DatedRow & {
    id?: number;
    userId: number;
    itemsJson: unknown;
    note: string | null;
    covers: number | null;
  };

  type CoverSnapRow = DatedRow & { id?: number; covers: number };

  const latestTicket = pickLatestPerTable<TicketSnapRow>(
    ticketRows.map((r: TicketSnapRow) => ({
      id: r.id,
      area: r.area,
      tableLabel: r.tableLabel,
      createdAt: r.createdAt,
      userId: r.userId,
      itemsJson: r.itemsJson,
      note: r.note,
      covers: r.covers,
    })),
    sinceMsByKey,
  );

  const coverSince: Record<string, number | null> = {};
  for (const k of openKeys) coverSince[k] = sinceMsByKey[k];
  const latestCover = pickLatestPerTable<CoverSnapRow>(
    coverRows.map(
      (r: {
        id?: number;
        area: string;
        label: string;
        createdAt: Date;
        covers: number;
      }) => ({
        id: r.id,
        area: r.area,
        tableLabel: r.label,
        createdAt: r.createdAt,
        covers: r.covers,
      }),
    ),
    coverSince,
  );

  const tables: FloorTableSnapshot[] = [];
  for (const k of openKeys) {
    const parts = splitTableKey(k)!;
    const ticket = latestTicket.get(k);
    const cover = latestCover.get(k);
    const items = asTicketLogItems(ticket?.itemsJson) as Parameters<
      typeof ticketRunningTotal
    >[0];
    tables.push({
      area: parts.area,
      label: parts.label,
      openedAt: openedAtByKey[k] || null,
      userId: ticket?.userId ?? null,
      covers: cover?.covers ?? ticket?.covers ?? null,
      total: ticketRunningTotal(items),
      // Occupancy only. Shipping every bill's lines on a 4s poll is what
      // made Android spend a second in JSON.parse before the floor painted.
      // The tapped table still hydrates from getLatestForTable / ticket cache.
      items: [],
      note: ticket ? stripTransferTagsFromNote(ticket.note) || null : null,
    });
  }
  return { tables };
}
