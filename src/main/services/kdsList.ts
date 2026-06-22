import { prisma } from '@db/client';
import {
  ALL_KDS_STATIONS,
  kdsStationLabel,
  type KdsStation,
} from '@shared/kdsStations';
import {
  isTwoStageKitchen,
  viewKitchenItemsForCooker,
  type CookerTab,
} from '@shared/kdsCooker';

export type KdsListOptions = {
  /** This screen is the cooker's display (first of the two kitchen stages). */
  cooker?: boolean;
  /** POS-host setting: two-stage cook → pass flow is active. */
  cookerEnabled?: boolean;
};

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
  options: KdsListOptions = {},
) {
  const twoStage = isTwoStageKitchen(station, options.cookerEnabled);
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
  const waiterById = new Map<number, string>(
    users.map(
      (u: { id: number; displayName: string }) =>
        [u.id, u.displayName] as const,
    ),
  );

  return (rows as any[])
    .map((r: any) => {
      const t = r.ticket;
      const o = t?.order;
      const area = String(o?.area || '');
      const tableLabel = String(o?.tableLabel || '');
      const tableKey = `${area}:${tableLabel}`;
      const ownerId = ownerByTable.get(tableKey);
      const waiterName =
        (ownerId ? waiterById.get(ownerId) : null) ??
        (t?.userId ? waiterById.get(Number(t.userId)) : null) ??
        null;

      const itemsAll = Array.isArray(t?.itemsJson) ? t.itemsJson : [];
      const stationItems = itemsAll
        .map((it: any, idx: number) => ({ ...it, _idx: idx }))
        .filter(
          (it: any) => String(it?.station || '').toUpperCase() === station,
        );
      if (stationItems.length === 0) return null;

      let items = stationItems;
      if (twoStage) {
        // Cooker (cook → pass) view: filter + flag lines for this screen's role.
        items = viewKitchenItemsForCooker(stationItems, {
          cooker: Boolean(options.cooker),
          tab: (status as CookerTab) === 'DONE' ? 'DONE' : 'NEW',
        });
        if (items.length === 0) return null;
      } else if (status === 'NEW') {
        // Keep the card on NEW while any line is still open (including voided).
        const hasOpen = stationItems.some((it: any) => !it?.bumped);
        if (!hasOpen) return null;
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

export type KdsTicketDetailDTO = {
  ticketId: number;
  orderNo: number;
  area: string;
  tableLabel: string;
  waiterName?: string | null;
  firedAt: string;
  note?: string | null;
  stations: Array<{
    station: KdsStation | string;
    label: string;
    items: Array<{
      name: string;
      qty?: number;
      note?: string;
      voided?: boolean;
      bumped?: boolean;
      _idx?: number;
    }>;
  }>;
};

/** Full ticket view with every prep station's items (for bump-bar summary). */
export async function getKdsTicketDetail(
  ticketId: number,
): Promise<KdsTicketDetailDTO | null> {
  const id = Number(ticketId);
  if (!id) return null;

  const row = await (prisma as any).kdsTicket
    .findUnique({
      where: { id },
      include: { order: true },
    })
    .catch(() => null);
  if (!row) return null;

  const o = row.order;
  const area = String(o?.area || '');
  const tableLabel = String(o?.tableLabel || '');
  const tableKey = `${area}:${tableLabel}`;

  const ownerId = await getSessionOwnerId(area, tableLabel);
  const userIds = [Number(row.userId), ownerId != null ? ownerId : 0].filter(
    (uid) => Number.isFinite(uid) && uid > 0,
  );

  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true },
        })
      : [];
  const waiterById = new Map<number, string>(
    users.map(
      (u: { id: number; displayName: string }) =>
        [u.id, u.displayName] as const,
    ),
  );
  const waiterName: string | null =
    (ownerId ? waiterById.get(ownerId) : null) ??
    (row.userId ? waiterById.get(Number(row.userId)) : null) ??
    null;

  const itemsAll = Array.isArray(row.itemsJson) ? row.itemsJson : [];
  const byStation = new Map<
    string,
    KdsTicketDetailDTO['stations'][0]['items']
  >();
  for (let idx = 0; idx < itemsAll.length; idx++) {
    const it = itemsAll[idx];
    const st = String(it?.station || 'KITCHEN').toUpperCase();
    if (!byStation.has(st)) byStation.set(st, []);
    byStation.get(st)!.push({
      name: String(it?.name || ''),
      qty: it?.qty != null ? Number(it.qty) : undefined,
      note: it?.note ? String(it.note) : undefined,
      voided: Boolean(it?.voided),
      bumped: Boolean(it?.bumped),
      _idx: idx,
    });
  }

  const stations: KdsTicketDetailDTO['stations'] = [];
  for (const st of ALL_KDS_STATIONS) {
    const items = byStation.get(st) || [];
    if (items.length === 0) continue;
    stations.push({
      station: st,
      label: kdsStationLabel(st),
      items,
    });
    byStation.delete(st);
  }
  for (const [st, items] of byStation) {
    if (items.length === 0) continue;
    stations.push({ station: st, label: st, items });
  }

  return {
    ticketId: id,
    orderNo: Number(o?.orderNo || 0),
    area,
    tableLabel,
    waiterName,
    firedAt: row.firedAt?.toISOString?.() ?? '',
    note: row.note ?? null,
    stations,
  };
}
