import { prisma } from '@db/client';
import { proposedSessionKeys, type SessionKeyRow } from '@shared/ticketRevenue';
import { buildTableSessionKey } from './tableSession';

/**
 * Each Send writes a full ticket snapshot. Reports only need the newest
 * row per sitting (`latestRowPerSession`). Keeping every fire forever is
 * what made the floor `LIMIT 800` miss quiet tables.
 *
 * Three newest rows per `sessionKey` is enough for a hydrate/send race
 * without retaining a whole dinner's worth of JSON blobs.
 */
export const TICKET_LOG_KEEP_PER_SESSION = 3;

export function ticketLogIdsToDrop(
  idsNewestFirst: number[],
  keep = TICKET_LOG_KEEP_PER_SESSION,
): number[] {
  if (keep < 1) return [...idsNewestFirst];
  return idsNewestFirst
    .slice(keep)
    .filter((id) => Number.isInteger(id) && id > 0);
}

type CompactClient = {
  ticketLog: {
    findMany: (args: unknown) => Promise<Array<{ id: number }>>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
};

type BackfillClient = CompactClient & {
  ticketLog: CompactClient['ticketLog'] & {
    updateMany: (args: unknown) => Promise<{ count: number }>;
    groupBy?: (
      args: unknown,
    ) => Promise<
      Array<{
        sessionKey: string | null;
        _count: { _all?: number; id?: number };
      }>
    >;
  };
};

export async function compactTicketLogSession(
  sessionKey: string | null | undefined,
  client: CompactClient = prisma as CompactClient,
): Promise<number> {
  const key = String(sessionKey || '').trim();
  if (!key) return 0;
  try {
    const newest = await client.ticketLog.findMany({
      where: { sessionKey: key },
      orderBy: { id: 'desc' },
      take: TICKET_LOG_KEEP_PER_SESSION,
      select: { id: true },
    });
    if (newest.length < TICKET_LOG_KEEP_PER_SESSION) return 0;
    const keepIds = newest.map((r) => r.id);
    const result = await client.ticketLog.deleteMany({
      where: { sessionKey: key, id: { notIn: keepIds } },
    });
    return Number(result?.count || 0);
  } catch {
    return 0;
  }
}

export async function compactOversizedTicketLogSessions(
  keys: string[],
  client: CompactClient = prisma as CompactClient,
): Promise<number> {
  let purged = 0;
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = String(raw || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    purged += await compactTicketLogSession(key, client);
  }
  return purged;
}

function idsBySessionKey(
  assignments: Map<number, string>,
): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  for (const [id, key] of assignments) {
    const list = byKey.get(key);
    if (list) list.push(id);
    else byKey.set(key, [id]);
  }
  return byKey;
}

export async function applyTicketLogSessionKeys(
  assignments: Map<number, string>,
  client: BackfillClient,
): Promise<number> {
  let keyed = 0;
  for (const [key, ids] of idsBySessionKey(assignments)) {
    if (ids.length === 0) continue;
    const result = await client.ticketLog.updateMany({
      where: {
        id: { in: ids },
        OR: [{ sessionKey: null }, { sessionKey: '' }],
      },
      data: { sessionKey: key },
    });
    keyed += Number(result?.count || 0);
  }
  return keyed;
}

async function loadUnkeyedTableLogs(
  client: BackfillClient,
): Promise<SessionKeyRow[]> {
  const tables = await client.ticketLog.findMany({
    where: { OR: [{ sessionKey: null }, { sessionKey: '' }] },
    distinct: ['area', 'tableLabel'],
    select: { area: true, tableLabel: true },
  });
  if (!Array.isArray(tables) || tables.length === 0) return [];

  const rows: SessionKeyRow[] = [];
  for (const t of tables as Array<{ area?: string; tableLabel?: string }>) {
    const area = String(t?.area || '');
    const tableLabel = String(t?.tableLabel || '');
    if (!area || !tableLabel) continue;
    const batch = await client.ticketLog.findMany({
      where: { area, tableLabel },
      select: {
        id: true,
        area: true,
        tableLabel: true,
        sessionKey: true,
        createdAt: true,
        itemsJson: true,
      },
      orderBy: { id: 'asc' },
    });
    for (const row of batch as SessionKeyRow[]) rows.push(row);
  }
  return rows;
}

async function oversizedSessionKeys(client: BackfillClient): Promise<string[]> {
  if (typeof client.ticketLog.groupBy !== 'function') return [];
  try {
    const grouped = await client.ticketLog.groupBy({
      by: ['sessionKey'],
      where: {
        NOT: { OR: [{ sessionKey: null }, { sessionKey: '' }] },
      },
      _count: { id: true },
    });
    const out: string[] = [];
    for (const row of grouped || []) {
      const key = String(row?.sessionKey || '').trim();
      const n = Number(row?._count?.id ?? row?._count?._all ?? 0);
      if (key && n > TICKET_LOG_KEEP_PER_SESSION) out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One-shot boot repair: give legacy TicketLog rows a sessionKey, then drop
 * older-than-keep snapshots. Compact-on-send already covers new fires.
 */
export async function backfillAndCompactTicketLogs(
  client: BackfillClient = prisma as BackfillClient,
): Promise<{ keyed: number; compacted: number }> {
  const rows = await loadUnkeyedTableLogs(client);
  const keyed = await applyTicketLogSessionKeys(
    proposedSessionKeys(rows, buildTableSessionKey),
    client,
  );
  const compacted = await compactOversizedTicketLogSessions(
    await oversizedSessionKeys(client),
    client,
  );
  return { keyed, compacted };
}
