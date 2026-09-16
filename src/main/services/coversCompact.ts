import { prisma } from '@db/client';

/**
 * Covers are rewritten every time a waiter adjusts headcount. The floor
 * and "covers today" only need the newest row per table. Keeping every
 * correction forever is the same class of growth as uncompacted TicketLog.
 */
export const COVERS_KEEP_PER_TABLE = 3;

type CoversClient = {
  covers: {
    findMany: (args: unknown) => Promise<Array<{ id: number }>>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    groupBy?: (args: unknown) => Promise<
      Array<{
        area: string;
        label: string;
        _count: { _all?: number; id?: number };
      }>
    >;
  };
};

export async function compactCoversForTable(
  area: string,
  label: string,
  client: CoversClient = prisma as CoversClient,
): Promise<number> {
  const a = String(area || '').trim();
  const l = String(label || '').trim();
  if (!a || !l) return 0;
  try {
    const newest = await client.covers.findMany({
      where: { area: a, label: l },
      orderBy: { id: 'desc' },
      take: COVERS_KEEP_PER_TABLE,
      select: { id: true },
    });
    if (newest.length < COVERS_KEEP_PER_TABLE) return 0;
    const keepIds = newest.map((r) => r.id);
    const result = await client.covers.deleteMany({
      where: { area: a, label: l, id: { notIn: keepIds } },
    });
    return Number(result?.count || 0);
  } catch {
    return 0;
  }
}

export async function compactOversizedCovers(
  client: CoversClient = prisma as CoversClient,
): Promise<number> {
  if (typeof client.covers.groupBy !== 'function') return 0;
  let purged = 0;
  try {
    const grouped = await client.covers.groupBy({
      by: ['area', 'label'],
      _count: { id: true },
    });
    for (const row of grouped || []) {
      const n = Number(row?._count?.id ?? row?._count?._all ?? 0);
      if (n <= COVERS_KEEP_PER_TABLE) continue;
      purged += await compactCoversForTable(row.area, row.label, client);
    }
  } catch {
    return purged;
  }
  return purged;
}
