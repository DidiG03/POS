import type { PrismaClient } from '@prisma/client';

import {
  COOKER_STATION,
  cookerUnbumpAllKitchenItems,
  cookerUnbumpSingleKitchenItem,
} from '@shared/kdsCooker';
import { localDayStart } from './kdsRetention';

function unbumpItem(it: any) {
  if (!it?.bumped) return it;
  const { bumped, bumpedAt, ...rest } = it;
  return rest;
}

function stationMatches(it: any, station: string) {
  return String(it?.station || '').toUpperCase() === station;
}

/** Mark every active station item as bumped (used when bumping a whole ticket). */
export function bumpAllStationItemsInJson(
  itemsAll: any[],
  station: string,
  bumpedAt: string,
): any[] {
  return itemsAll.map((it) => {
    if (!stationMatches(it, station) || it?.voided || it?.bumped) return it;
    return { ...it, bumped: true, bumpedAt };
  });
}

/** Recall one item back to NEW; keep every other station item bumped. */
function recallSingleStationItemInJson(
  itemsAll: any[],
  station: string,
  itemIdx: number,
): any[] {
  const bumpedAt = new Date().toISOString();
  return itemsAll.map((it, idx) => {
    if (!stationMatches(it, station) || it?.voided) return it;
    if (idx === itemIdx) return unbumpItem(it);
    if (it?.bumped) return it;
    return { ...it, bumped: true, bumpedAt: it.bumpedAt || bumpedAt };
  });
}

async function recallWholeTicketRow(
  prisma: PrismaClient,
  station: string,
  row: { ticketId: number; ticket: any },
) {
  const itemsAll: any[] = Array.isArray(row.ticket?.itemsJson)
    ? row.ticket.itemsJson
    : [];
  const nextItems = itemsAll.map((it: any) => {
    if (String(it?.station || '').toUpperCase() !== station) return it;
    return unbumpItem(it);
  });

  await (prisma as any).$transaction([
    (prisma as any).kdsTicket.update({
      where: { id: row.ticketId },
      data: { itemsJson: nextItems },
    }),
    (prisma as any).kdsTicketStation.updateMany({
      where: { ticketId: row.ticketId, station, status: 'DONE' },
      data: {
        status: 'NEW',
        bumpedAt: null,
        bumpedById: null,
      },
    }),
  ]);

  return { ok: true as const, ticketId: row.ticketId };
}

function cookerBumpedAtMs(it: any): number {
  const t = new Date(String(it?.cookerBumpedAt || '')).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function persistCookerItems(
  prisma: PrismaClient,
  ticketId: number,
  items: any[],
) {
  await (prisma as any).kdsTicket.update({
    where: { id: ticketId },
    data: { itemsJson: items },
  });
}

async function recallCookerTicket(
  prisma: PrismaClient,
  input: {
    station: string;
    ticketId: number | null;
    itemIdx: number | null;
  },
) {
  const station = COOKER_STATION;
  const ticketId = input.ticketId;
  const itemIdx = input.itemIdx;

  const loadNewRow = async (id: number) =>
    (prisma as any).kdsTicketStation
      .findFirst({
        where: { ticketId: id, station, status: 'NEW' },
        include: { ticket: true },
      })
      .catch(() => null);

  if (ticketId && itemIdx != null && itemIdx >= 0) {
    const row = await loadNewRow(ticketId);
    if (!row?.ticket) return { ok: false as const, ticketId: null };
    const itemsAll: any[] = Array.isArray(row.ticket.itemsJson)
      ? row.ticket.itemsJson
      : [];
    if (itemIdx >= itemsAll.length)
      return { ok: false as const, ticketId: null };
    const nextItems = cookerUnbumpSingleKitchenItem(itemsAll, itemIdx);
    await persistCookerItems(prisma, ticketId, nextItems);
    return { ok: true as const, ticketId, itemRecalled: true as const };
  }

  if (ticketId) {
    const row = await loadNewRow(ticketId);
    if (!row?.ticket) return { ok: false as const, ticketId: null };
    const itemsAll: any[] = Array.isArray(row.ticket.itemsJson)
      ? row.ticket.itemsJson
      : [];
    await persistCookerItems(
      prisma,
      ticketId,
      cookerUnbumpAllKitchenItems(itemsAll),
    );
    return { ok: true as const, ticketId };
  }

  const rows = await (prisma as any).kdsTicketStation
    .findMany({
      where: { station, status: 'NEW' },
      include: { ticket: true },
      orderBy: { ticket: { firedAt: 'desc' } },
      take: 80,
    })
    .catch(() => []);
  let best: { ticketId: number; items: any[] } | null = null;
  let bestAt = 0;
  for (const row of rows || []) {
    const id = Number(row?.ticketId || row?.ticket?.id || 0);
    const itemsAll: any[] = Array.isArray(row?.ticket?.itemsJson)
      ? row.ticket.itemsJson
      : [];
    for (const it of itemsAll) {
      if (
        String(it?.station || '').toUpperCase() !== station ||
        it?.voided ||
        it?.bumped ||
        !it?.cookerBumped
      ) {
        continue;
      }
      const at = cookerBumpedAtMs(it);
      if (at >= bestAt) {
        bestAt = at;
        best = { ticketId: id, items: itemsAll };
      }
    }
  }
  if (!best?.ticketId) return { ok: false as const, ticketId: null };
  await persistCookerItems(
    prisma,
    best.ticketId,
    cookerUnbumpAllKitchenItems(best.items),
  );
  return { ok: true as const, ticketId: best.ticketId };
}

export async function recallKdsTicket(
  prisma: PrismaClient,
  input: {
    station: string;
    ticketId?: number | null;
    itemIdx?: number | null;
    cooker?: boolean;
  },
) {
  const station = String(input.station || 'KITCHEN').toUpperCase();
  const ticketId = Number(input.ticketId || 0) || null;
  const itemIdx =
    input.itemIdx != null && Number.isFinite(Number(input.itemIdx))
      ? Number(input.itemIdx)
      : null;

  try {
    if (input.cooker && station === COOKER_STATION) {
      return await recallCookerTicket(prisma, { station, ticketId, itemIdx });
    }

    if (ticketId && itemIdx != null && itemIdx >= 0) {
      const row = await (prisma as any).kdsTicketStation
        .findFirst({
          where: { ticketId, station, status: 'DONE' },
          include: { ticket: true },
        })
        .catch(() => null);
      if (!row?.ticket) return { ok: false as const, ticketId: null };

      const itemsAll: any[] = Array.isArray(row.ticket.itemsJson)
        ? row.ticket.itemsJson
        : [];
      if (itemIdx >= itemsAll.length)
        return { ok: false as const, ticketId: null };

      const it = itemsAll[itemIdx];
      if (!it || String(it?.station || '').toUpperCase() !== station) {
        return { ok: false as const, ticketId: null };
      }

      const nextItems = recallSingleStationItemInJson(
        itemsAll,
        station,
        itemIdx,
      );

      await (prisma as any).$transaction([
        (prisma as any).kdsTicket.update({
          where: { id: ticketId },
          data: { itemsJson: nextItems },
        }),
        (prisma as any).kdsTicketStation.updateMany({
          where: { ticketId, station, status: 'DONE' },
          data: {
            status: 'NEW',
            bumpedAt: null,
            bumpedById: null,
          },
        }),
      ]);

      return { ok: true as const, ticketId, itemRecalled: true as const };
    }

    if (ticketId) {
      const row = await (prisma as any).kdsTicketStation
        .findFirst({
          where: { ticketId, station, status: 'DONE' },
          include: { ticket: true },
        })
        .catch(() => null);
      if (!row) return { ok: false as const, ticketId: null };
      return await recallWholeTicketRow(prisma, station, row);
    }

    const row = await (prisma as any).kdsTicketStation
      .findFirst({
        where: {
          station,
          status: 'DONE',
          bumpedAt: { gte: localDayStart() },
        },
        orderBy: { bumpedAt: 'desc' },
        include: { ticket: true },
      })
      .catch(() => null);
    if (!row) return { ok: false as const, ticketId: null };
    return await recallWholeTicketRow(prisma, station, row);
  } catch {
    return { ok: false as const, ticketId: null };
  }
}
