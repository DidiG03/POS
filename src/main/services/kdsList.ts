import { prisma } from '@db/client';

async function getTableSessionStartedAt(
  area: string,
  label: string,
): Promise<Date | null> {
  const openAtRow = await prisma.syncState
    .findUnique({ where: { key: 'tables:openAt' } })
    .catch(() => null);
  const openAtMap = ((openAtRow?.valueJson as any) || {}) as Record<
    string,
    string
  >;
  const openAtIso = openAtMap[`${area}:${label}`];
  if (!openAtIso) return null;
  const sessionStart = new Date(openAtIso);
  if (Number.isNaN(sessionStart.getTime())) return null;
  return sessionStart;
}

async function getSessionOwnerId(
  area: string,
  tableLabel: string,
): Promise<number | null> {
  const sessionStart = await getTableSessionStartedAt(area, tableLabel);
  if (!sessionStart) return null;
  const last = await prisma.ticketLog
    .findFirst({
      where: {
        area,
        tableLabel,
        createdAt: { gte: sessionStart },
      },
      orderBy: { createdAt: 'desc' },
      select: { userId: true },
    })
    .catch(() => null);
  return last ? Number(last.userId) : null;
}

export async function formatKdsTicketListRows(
  rows: any[],
  station: string,
  status: string,
) {
  const tableKeys = Array.from(
    new Set(
      (rows as any[])
        .map((r) => {
          const o = r?.ticket?.order;
          const area = String(o?.area || '').trim();
          const tableLabel = String(o?.tableLabel || '').trim();
          return area && tableLabel ? `${area}:${tableLabel}` : '';
        })
        .filter(Boolean),
    ),
  );

  const ownerByTable = new Map<string, number>();
  await Promise.all(
    tableKeys.map(async (key) => {
      const [area, ...rest] = key.split(':');
      const tableLabel = rest.join(':');
      const ownerId = await getSessionOwnerId(area, tableLabel);
      if (ownerId) ownerByTable.set(key, ownerId);
    }),
  );

  const userIds = Array.from(
    new Set([
      ...(rows as any[])
        .map((r) => Number(r?.ticket?.userId))
        .filter((id) => Number.isFinite(id) && id > 0),
      ...ownerByTable.values(),
    ]),
  );

  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true },
        })
      : [];
  const waiterById = new Map(users.map((u) => [u.id, u.displayName] as const));

  return (rows as any[])
    .map((r: any) => {
      const t = r.ticket;
      const o = t?.order;
      const area = String(o?.area || '');
      const tableLabel = String(o?.tableLabel || '');
      const tableKey = `${area}:${tableLabel}`;
      const ownerId = ownerByTable.get(tableKey);
      const waiterName =
        (t?.userId ? waiterById.get(Number(t.userId)) : null) ??
        (ownerId ? waiterById.get(ownerId) : null) ??
        null;

      const itemsAll = Array.isArray(t?.itemsJson) ? t.itemsJson : [];
      const items = itemsAll
        .map((it: any, idx: number) => ({ ...it, _idx: idx }))
        .filter(
          (it: any) => String(it?.station || '').toUpperCase() === station,
        );
      if (items.length === 0) return null;
      if (status === 'NEW') {
        const hasActive = items.some((it: any) => !it?.voided && !it?.bumped);
        if (!hasActive) return null;
      }

      return {
        ticketId: t?.id,
        orderNo: o?.orderNo,
        area,
        tableLabel,
        waiterName,
        firedAt: t?.firedAt?.toISOString?.() ?? null,
        note: t?.note ?? null,
        items,
        bumpedAt: r?.bumpedAt?.toISOString?.() ?? null,
      };
    })
    .filter(Boolean);
}
