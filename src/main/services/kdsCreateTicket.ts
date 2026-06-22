import { prisma } from '@db/client';
import { ALL_KDS_STATIONS } from '@shared/kdsStations';
import { coreServices } from './core';
import { dayKeyLocal } from './kdsRetention';
import { ensureKdsLocalSchema } from './kdsSchema';
import {
  decorateKdsTicketItemsFromCategory,
  enabledStationsFromSettings,
  kdsStationsWithActiveItems,
  loadKdsRoutingFromDb,
} from './kdsStationRouting';

export type CreateKdsTicketInput = {
  userId: number;
  area: string;
  tableLabel: string;
  items: any[];
  /** Newly fired lines only — merged into the open KDS ticket when present. */
  fireItems?: any[];
  note?: string | null;
};

/**
 * Create or extend the kitchen ticket for a table send. When the table
 * already has a KDS order with a NEW ticket, newly fired items are
 * appended to that ticket instead of spawning a second card — this is
 * what waiters expect when they "fire" additional items on an open table.
 */
export async function createKdsTicketFromLog(
  input: CreateKdsTicketInput,
): Promise<{ orderNo: number; ticketId: number } | null> {
  const okSchema = await ensureKdsLocalSchema();
  if (!okSchema) return null;

  let enabled: Set<string>;
  try {
    const settings: any = await coreServices.readSettings();
    enabled = enabledStationsFromSettings(settings);
  } catch {
    enabled = new Set(ALL_KDS_STATIONS);
  }

  const rawLines = Array.isArray(input.fireItems)
    ? input.fireItems
    : Array.isArray(input.items)
      ? input.items
      : [];
  if (rawLines.length === 0) return null;

  const routing = await loadKdsRoutingFromDb(prisma).catch(() => ({
    categoryIdToKdsStation: {},
    skuToKdsStation: {},
  }));
  const decorated = decorateKdsTicketItemsFromCategory(rawLines, routing);
  const usedStations = kdsStationsWithActiveItems(decorated, enabled);
  if (usedStations.length === 0) return null;

  const now = new Date();
  const dayKey = dayKeyLocal(now);

  const created = await (prisma as any).$transaction(async (tx: any) => {
    let safeUserId: number | null = null;
    try {
      const u = await tx.user.findUnique({
        where: { id: Number(input.userId) },
      });
      safeUserId = u ? Number(input.userId) : null;
    } catch {
      safeUserId = null;
    }

    let order = await tx.kdsOrder.findFirst({
      where: {
        area: input.area,
        tableLabel: input.tableLabel,
        closedAt: null,
      },
      orderBy: { openedAt: 'desc' },
    });
    if (!order) {
      const counter = await tx.kdsDayCounter.upsert({
        where: { dayKey },
        create: { dayKey, lastNo: 0 },
        update: {},
      });
      const nextNo = Number(counter?.lastNo || 0) + 1;
      await tx.kdsDayCounter.update({
        where: { dayKey },
        data: { lastNo: nextNo },
      });
      order = await tx.kdsOrder.create({
        data: {
          dayKey,
          orderNo: nextNo,
          area: input.area,
          tableLabel: input.tableLabel,
          openedAt: now,
        },
      });
    }

    const existingTicket = await tx.kdsTicket.findFirst({
      where: {
        orderId: order.id,
        stations: { some: { status: 'NEW' } },
      },
      orderBy: { id: 'desc' },
    });

    if (existingTicket) {
      const prev = Array.isArray(existingTicket.itemsJson)
        ? (existingTicket.itemsJson as any[])
        : [];
      const merged = [...prev, ...decorated];
      await tx.kdsTicket.update({
        where: { id: existingTicket.id },
        data: { itemsJson: merged },
      });
      for (const st of usedStations) {
        const row = await tx.kdsTicketStation.findFirst({
          where: { ticketId: existingTicket.id, station: st },
        });
        if (!row) {
          await tx.kdsTicketStation.create({
            data: { ticketId: existingTicket.id, station: st, status: 'NEW' },
          });
        } else if (String(row.status || '').toUpperCase() !== 'NEW') {
          await tx.kdsTicketStation.update({
            where: { id: row.id },
            data: {
              status: 'NEW',
              bumpedAt: null,
              bumpedById: null,
            },
          });
        }
      }
      return { orderNo: order.orderNo, ticketId: existingTicket.id };
    }

    const ticket = await tx.kdsTicket.create({
      data: {
        orderId: order.id,
        userId: safeUserId,
        firedAt: now,
        itemsJson: decorated,
        note: input.note ?? null,
      },
    });

    for (const st of usedStations) {
      await tx.kdsTicketStation.create({
        data: {
          ticketId: ticket.id,
          station: st,
          status: 'NEW',
        },
      });
    }

    return { orderNo: order.orderNo, ticketId: ticket.id };
  });

  return created;
}
