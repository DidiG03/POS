import { prisma } from '@db/client';
import {
  ALL_KDS_STATIONS,
  kdsStationLabel,
  type KdsStation,
} from '@shared/kdsStations';
import {
  COOKER_STATION,
  isTwoStageKitchen,
  kdsStationRowVisible,
  ticketLogLooksFullyVoided,
  viewKitchenItemsForCooker,
  type CookerTab,
} from '@shared/kdsCooker';
import { splitTableKey } from '@shared/utils/tableKey';
import { kdsStationListWhere } from './kdsRetention';
import {
  floorItemsFromTicket,
  type KdsFloorOrder,
} from '@shared/kdsFloorOrders';
import { broadcastTicketsChanged } from './realtime';

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

/** Closed KDS orders whose POS ticket was voided (including pre-fix leftovers). */
async function voidedClosedOrderIds(rows: any[]): Promise<Set<number>> {
  const byId = new Map<number, any>();
  for (const r of rows as any[]) {
    const o = r?.ticket?.order;
    const id = Number(o?.id);
    if (!id || !o?.closedAt || byId.has(id)) continue;
    byId.set(id, o);
  }
  const out = new Set<number>();
  await Promise.all(
    [...byId.values()].map(async (o) => {
      const openedAt =
        o.openedAt instanceof Date ? o.openedAt : new Date(o.openedAt);
      const closedAt =
        o.closedAt instanceof Date ? o.closedAt : new Date(o.closedAt);
      if (
        Number.isNaN(openedAt.getTime()) ||
        Number.isNaN(closedAt.getTime())
      ) {
        return;
      }
      const last = await prisma.ticketLog
        .findFirst({
          where: {
            area: String(o.area || ''),
            tableLabel: String(o.tableLabel || ''),
            createdAt: { gte: openedAt, lte: closedAt },
          },
          orderBy: { createdAt: 'desc' },
          select: { itemsJson: true, note: true },
        })
        .catch(() => null);
      if (ticketLogLooksFullyVoided(last)) out.add(Number(o.id));
    }),
  );
  return out;
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
      const parsed = splitTableKey(key);
      if (!parsed) return;
      const { area, label: tableLabel } = parsed;
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

  const voidedOrderIds = await voidedClosedOrderIds(rows);

  return (rows as any[])
    .map((r: any) => {
      const t = r.ticket;
      const o = t?.order;
      if (voidedOrderIds.has(Number(o?.id))) return null;
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
      } else if (!kdsStationRowVisible(stationItems, status)) {
        return null;
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

export function notifyKdsTicketChanged(ticket: any) {
  const o = ticket?.order;
  if (!o) return;
  try {
    broadcastTicketsChanged({
      area: String(o.area || ''),
      tableLabel: String(o.tableLabel || ''),
      userId: Number(ticket.userId || 0) || null,
    });
  } catch {
    // broadcasting is best-effort
  }
}

async function waiterUserIdForTicket(ticket: any): Promise<number | null> {
  const o = ticket?.order;
  const area = String(o?.area || '');
  const tableLabel = String(o?.tableLabel || '');
  const ownerId =
    area && tableLabel ? await getSessionOwnerId(area, tableLabel) : null;
  const fromTicket = Number(ticket?.userId || 0);
  if (ownerId && ownerId > 0) return ownerId;
  if (Number.isFinite(fromTicket) && fromTicket > 0) return fromTicket;
  return null;
}

/**
 * View-only board for the signed-in waiter: live lines on enabled KDS
 * stations that this waiter owns. Items leave when the kitchen display bumps
 * them — the POS Orders tab cannot bump.
 */
export async function listWaiterFloorOrders(
  stations: string[],
  options: { waiterUserId?: number } = {},
): Promise<KdsFloorOrder[]> {
  const enabled = [
    ...new Set(stations.map((s) => String(s || '').toUpperCase())),
  ].filter(Boolean);
  const waiterUserId = Number(options.waiterUserId || 0);
  if (enabled.length === 0 || !waiterUserId) return [];

  const enabledSet = new Set(enabled);

  const byTicket = new Map<number, any>();
  for (const station of enabled) {
    const rows = await (prisma as any).kdsTicketStation.findMany({
      where: kdsStationListWhere(station, 'NEW'),
      include: { ticket: { include: { order: true } } },
      take: 100,
    });
    for (const row of rows as any[]) {
      const ticket = row?.ticket;
      const id = Number(ticket?.id);
      if (!id || byTicket.has(id)) continue;
      byTicket.set(id, ticket);
    }
  }

  const tickets = [...byTicket.values()];
  const voidedOrderIds = await voidedClosedOrderIds(
    tickets.map((ticket) => ({ ticket })),
  );
  const waiter = await prisma.user
    .findUnique({
      where: { id: waiterUserId },
      select: { displayName: true },
    })
    .catch(() => null);
  const waiterName = waiter?.displayName ?? null;

  const out: KdsFloorOrder[] = [];
  for (const ticket of tickets) {
    const o = ticket?.order;
    if (voidedOrderIds.has(Number(o?.id))) continue;
    const ownerId = await waiterUserIdForTicket(ticket);
    if (ownerId !== waiterUserId) continue;
    const items = floorItemsFromTicket(
      Array.isArray(ticket?.itemsJson) ? ticket.itemsJson : [],
      enabledSet,
    );
    if (items.length === 0) continue;
    out.push({
      ticketId: Number(ticket.id),
      orderNo: Number(o?.orderNo || 0),
      area: String(o?.area || ''),
      tableLabel: String(o?.tableLabel || ''),
      waiterName,
      waiterUserId,
      firedAt: ticket?.firedAt?.toISOString?.() ?? null,
      note: ticket?.note ?? null,
      items,
    });
  }

  return out.sort((a, b) =>
    String(a.firedAt || '').localeCompare(String(b.firedAt || '')),
  );
}
