import { prisma } from '@db/client';

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
