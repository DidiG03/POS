import { prisma } from '@db/client';
import { ALL_KDS_STATIONS } from '@shared/kdsStations';
import {
  courseKeyFromItems,
  isImmediateFireStation,
} from '@shared/ticketCourseFire';
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
  /** Printed on the KDS card when this fire is a later course. */
  courseLabel?: string | null;
};

function kdsFireBatches(decorated: any[]): any[][] {
  const drinks = decorated.filter((it) => isImmediateFireStation(it?.station));
  const food = decorated.filter((it) => !isImmediateFireStation(it?.station));
  const batches: any[][] = [];
  if (drinks.length) batches.push(drinks);
  if (food.length) batches.push(food);
  return batches;
}

async function upsertKdsTicket(opts: {
  tx: any;
  order: { id: number; orderNo: number };
  decorated: any[];
  usedStations: string[];
  safeUserId: number | null;
  now: Date;
  note?: string | null;
  courseLabel?: string | null;
}): Promise<{ orderNo: number; ticketId: number }> {
  const incomingCourseKey = courseKeyFromItems(opts.decorated);
  const openTickets = await opts.tx.kdsTicket.findMany({
    where: {
      orderId: opts.order.id,
      stations: { some: { status: 'NEW' } },
    },
    orderBy: { id: 'desc' },
  });
  const existingTicket = openTickets.find(
    (t: { itemsJson?: unknown }) =>
      courseKeyFromItems(t.itemsJson) === incomingCourseKey,
  );

  if (existingTicket) {
    const prev = Array.isArray(existingTicket.itemsJson)
      ? (existingTicket.itemsJson as any[])
      : [];
    const merged = [...prev, ...opts.decorated];
    await opts.tx.kdsTicket.update({
      where: { id: existingTicket.id },
      data: { itemsJson: merged },
    });
    for (const st of opts.usedStations) {
      const row = await opts.tx.kdsTicketStation.findFirst({
        where: { ticketId: existingTicket.id, station: st },
      });
      if (!row) {
        await opts.tx.kdsTicketStation.create({
          data: {
            ticketId: existingTicket.id,
            station: st,
            status: 'NEW',
          },
        });
      } else if (String(row.status || '').toUpperCase() !== 'NEW') {
        await opts.tx.kdsTicketStation.update({
          where: { id: row.id },
          data: {
            status: 'NEW',
            bumpedAt: null,
            bumpedById: null,
          },
        });
      }
    }
    return { orderNo: opts.order.orderNo, ticketId: existingTicket.id };
  }

  const isDrinksOnly = opts.decorated.every((it) =>
    isImmediateFireStation(it?.station),
  );
  const courseNote = isDrinksOnly ? '' : String(opts.courseLabel || '').trim();
  const ticketNote = courseNote
    ? [courseNote, opts.note].filter(Boolean).join(' · ')
    : (opts.note ?? null);
  const ticket = await opts.tx.kdsTicket.create({
    data: {
      orderId: opts.order.id,
      userId: opts.safeUserId,
      firedAt: opts.now,
      itemsJson: opts.decorated,
      note: ticketNote,
    },
  });

  for (const st of opts.usedStations) {
    await opts.tx.kdsTicketStation.create({
      data: {
        ticketId: ticket.id,
        station: st,
        status: 'NEW',
      },
    });
  }

  return { orderNo: opts.order.orderNo, ticketId: ticket.id };
}

/**
 * Create or extend kitchen tickets for a table send. Drinks are written
 * first as their own card (not a course). Food merges onto an existing
 * NEW ticket only when they share the same course.
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
  if (enabled.size === 0) return null;

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
  const batches = kdsFireBatches(decorated).filter(
    (batch) => kdsStationsWithActiveItems(batch, enabled).length > 0,
  );
  if (batches.length === 0) return null;

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

    let last: { orderNo: number; ticketId: number } | null = null;
    for (const batch of batches) {
      const usedStations = kdsStationsWithActiveItems(batch, enabled);
      last = await upsertKdsTicket({
        tx,
        order,
        decorated: batch,
        usedStations,
        safeUserId,
        now,
        note: input.note,
        courseLabel: input.courseLabel,
      });
    }
    return last;
  });

  return created;
}
