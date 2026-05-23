import type { PrismaClient } from '@prisma/client';

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

export async function recallKdsTicket(
  prisma: PrismaClient,
  input: {
    station: string;
    ticketId?: number | null;
    itemIdx?: number | null;
  },
) {
  const station = String(input.station || 'KITCHEN').toUpperCase();
  const ticketId = Number(input.ticketId || 0) || null;
  const itemIdx =
    input.itemIdx != null && Number.isFinite(Number(input.itemIdx))
      ? Number(input.itemIdx)
      : null;

  try {
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
