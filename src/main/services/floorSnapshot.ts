/**
 * One-shot floor payload for waiter tablets.
 *
 * The floor used to fan out one `tickets/latest` (and often a covers +
 * tooltip call) per occupied table. On a busy Saturday that is 40–80 LAN
 * round-trips every few seconds — the first thing that falls over when
 * restaurant Wi-Fi is congested.
 *
 * This query reads the open-table maps once, then one TicketLog and one
 * Covers scan for the area, and returns everything the floor (and a
 * table-tap hydrate) needs.
 */
import { prisma } from '@db/client';
import type { FloorSnapshot, FloorTableSnapshot } from '@shared/ipc';
import { splitTableKey, tableKey } from '@shared/utils/tableKey';
import { stripTransferTagsFromNote } from '@shared/utils/transferNote';

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
  createdAt: Date;
};

/**
 * Keep the newest row per table, ignoring anything written before that
 * table's current open session (`tables:openAt`).
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
    const t = row.createdAt.getTime();
    if (since != null && t < since) continue;
    const prev = out.get(key);
    if (!prev || t > prev.createdAt.getTime()) out.set(key, row);
  }
  return out;
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

export async function getFloorSnapshot(area?: string): Promise<FloorSnapshot> {
  const wantArea = String(area || '').trim();
  const [openRow, atRow] = await Promise.all([
    prisma.syncState.findUnique({ where: { key: 'tables:open' } }),
    prisma.syncState.findUnique({ where: { key: 'tables:openAt' } }),
  ]);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<
    string,
    boolean
  >;
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;

  const openKeys: string[] = [];
  const sinceMsByKey: Record<string, number | null> = {};
  let oldestSince: number | null = null;
  const labels: string[] = [];

  for (const k in openMap) {
    if (!openMap[k]) continue;
    const parts = splitTableKey(k);
    if (!parts) continue;
    if (wantArea && parts.area !== wantArea) continue;
    openKeys.push(k);
    labels.push(parts.label);
    const since = parseIsoMs(atMap[k]);
    sinceMsByKey[k] = since;
    if (since != null && (oldestSince == null || since < oldestSince)) {
      oldestSince = since;
    }
  }

  if (openKeys.length === 0) return { tables: [] };

  const areaFilter = wantArea || splitTableKey(openKeys[0])!.area;
  const sinceDate =
    oldestSince != null && Number.isFinite(oldestSince)
      ? new Date(oldestSince)
      : undefined;
  const sinceFilter = sinceDate ? { createdAt: { gte: sinceDate } } : {};
  const openPairs = openKeys
    .map((k) => splitTableKey(k))
    .filter((p): p is { area: string; label: string } => Boolean(p));
  const ticketWhere = wantArea
    ? { area: areaFilter, tableLabel: { in: labels }, ...sinceFilter }
    : {
        OR: openPairs.map((p) => ({ area: p.area, tableLabel: p.label })),
        ...sinceFilter,
      };
  const coverWhere = wantArea
    ? { area: areaFilter, label: { in: labels }, ...sinceFilter }
    : {
        OR: openPairs.map((p) => ({ area: p.area, label: p.label })),
        ...sinceFilter,
      };

  const [ticketRows, coverRows] = await Promise.all([
    prisma.ticketLog.findMany({
      where: ticketWhere,
      orderBy: { createdAt: 'desc' },
      take: Math.min(400, Math.max(50, openKeys.length * 8)),
      select: {
        area: true,
        tableLabel: true,
        createdAt: true,
        userId: true,
        itemsJson: true,
        note: true,
        covers: true,
      },
    }),
    prisma.covers.findMany({
      where: coverWhere,
      orderBy: { id: 'desc' },
      take: Math.min(400, Math.max(50, openKeys.length * 4)),
      select: {
        area: true,
        label: true,
        covers: true,
        createdAt: true,
      },
    }),
  ]);

  type TicketSnapRow = DatedRow & {
    userId: number;
    itemsJson: unknown;
    note: string | null;
    covers: number | null;
  };

  type CoverSnapRow = DatedRow & { covers: number };

  const latestTicket = pickLatestPerTable<TicketSnapRow>(
    ticketRows.map((r: TicketSnapRow) => ({
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
        area: string;
        label: string;
        createdAt: Date;
        covers: number;
      }) => ({
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
    const items = Array.isArray(ticket?.itemsJson)
      ? (ticket!.itemsJson as FloorTableSnapshot['items'])
      : [];
    tables.push({
      area: parts.area,
      label: parts.label,
      openedAt: atMap[k] || null,
      userId: ticket?.userId ?? null,
      covers: cover?.covers ?? ticket?.covers ?? null,
      total: ticketRunningTotal(items),
      items,
      note: ticket ? stripTransferTagsFromNote(ticket.note) || null : null,
    });
  }
  return { tables };
}
