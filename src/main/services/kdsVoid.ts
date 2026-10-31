import { prisma } from '@db/client';
import { ensureKdsLocalSchema } from './kdsSchema';

import { matchVoidableLine, type VoidTargetLine } from '@shared/voidLine';

export async function applyKdsVoidTicket(input: {
  userId: number;
  area: string;
  tableLabel: string;
  reason?: string;
}): Promise<boolean> {
  const okSchema = await ensureKdsLocalSchema();
  if (!okSchema) return false;
  const area = String(input.area || '');
  const tableLabel = String(input.tableLabel || '');
  if (!area || !tableLabel) return false;

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      // This sitting's order. A void that lands after the close (which
      // closes the KDS order too) may still take the last closed order, but
      // only while it has cards waiting in the kitchen — otherwise it is the
      // previous party's, already cooked, and must not be struck.
      const order =
        (await tx.kdsOrder.findFirst({
          where: { area, tableLabel, closedAt: null },
          orderBy: { openedAt: 'desc' },
        })) ||
        (await tx.kdsOrder.findFirst({
          where: {
            area,
            tableLabel,
            tickets: { some: { stations: { some: { status: 'NEW' } } } },
          },
          orderBy: { openedAt: 'desc' },
        }));
      if (!order) return;

      let safeBumpedById: number | null = null;
      try {
        const u = await tx.user.findUnique({
          where: { id: Number(input.userId) },
        });
        safeBumpedById = u ? Number(input.userId) : null;
      } catch {
        safeBumpedById = null;
      }

      const tickets = await tx.kdsTicket.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'asc' },
      });
      const now = new Date();
      for (const t of tickets) {
        const items = (Array.isArray(t.itemsJson) ? t.itemsJson : []).map(
          (it: any) => ({ ...it, voided: true }),
        );
        const note = t.note
          ? `${t.note} | VOIDED${input.reason ? `: ${input.reason}` : ''}`
          : `VOIDED${input.reason ? `: ${input.reason}` : ''}`;
        await tx.kdsTicket.update({
          where: { id: t.id },
          data: { itemsJson: items, note },
        });
        await tx.kdsTicketStation.updateMany({
          where: { ticketId: t.id, status: 'NEW' },
          data: {
            status: 'DONE',
            bumpedAt: now,
            ...(safeBumpedById ? { bumpedById: safeBumpedById } : {}),
          },
        });
      }
      if (!order.closedAt) {
        await tx.kdsOrder.update({
          where: { id: order.id },
          data: { closedAt: now },
        });
      }
    });
    return true;
  } catch {
    return false;
  }
}

type KdsLinePick = { ticket: any; items: any[]; index: number };

function lineIdOfItem(it: any): string {
  return String(it?.lineId || '').trim();
}

/**
 * The kitchen line a bill void strikes. By the bill line's id when the
 * kitchen has it: two "Espresso" lines at one price are otherwise the same,
 * and striking the one already served leaves the new one to be cooked.
 * Without an id (older cards), the closest match, preferring a line the
 * kitchen has not finished.
 */
export function pickKdsLineToVoid(
  tickets: Array<{ itemsJson?: unknown }>,
  target: VoidTargetLine | null | undefined,
): KdsLinePick | null {
  if (!target) return null;
  const cards = tickets.map((ticket) => ({
    ticket,
    items: Array.isArray(ticket.itemsJson) ? (ticket.itemsJson as any[]) : [],
  }));
  const lineId = String(target.lineId || '').trim();
  if (lineId) {
    for (const card of cards) {
      const index = card.items.findIndex(
        (it) => !it?.voided && lineIdOfItem(it) === lineId,
      );
      if (index !== -1) return { ...card, index };
    }
  }
  // A line with an id is some other bill line: only id-less lines are
  // candidates for a loose match.
  const candidate = (it: any, openOnly: boolean) =>
    !(lineId && lineIdOfItem(it)) && !(openOnly && it?.bumped);
  for (const openOnly of [true, false]) {
    // Station routing splits one check across several KDS tickets, so pick
    // the closest match across all of them rather than the first ticket
    // that happens to hold a same-named dish.
    let best: (KdsLinePick & { rank: number }) | null = null;
    for (const card of cards) {
      const masked = card.items.map((it) =>
        candidate(it, openOnly) ? it : { ...it, voided: true },
      );
      const match = matchVoidableLine(masked, target);
      if (match.index === -1) continue;
      if (!best || match.rank < best.rank) {
        best = { ...card, index: match.index, rank: match.rank };
      }
    }
    if (best)
      return { ticket: best.ticket, items: best.items, index: best.index };
  }
  return null;
}

/** Mark one matching line voided on the open KDS order (stays on NEW, struck through). */
export async function applyKdsVoidItem(input: {
  userId: number;
  area: string;
  tableLabel: string;
  item: any;
}): Promise<boolean> {
  const okSchema = await ensureKdsLocalSchema();
  if (!okSchema) return false;
  const area = String(input.area || '');
  const tableLabel = String(input.tableLabel || '');
  const name = String(input?.item?.name || '').trim();
  if (!area || !tableLabel || !name) return false;

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      const order = await tx.kdsOrder.findFirst({
        where: { area, tableLabel, closedAt: null },
        orderBy: { openedAt: 'desc' },
      });
      if (!order) return;

      const tickets = await tx.kdsTicket.findMany({
        where: { orderId: order.id },
        orderBy: { id: 'asc' },
      });

      const best = pickKdsLineToVoid(tickets, input.item);
      if (!best) return;

      const nextItems = best.items.map((it: any, i: number) =>
        i === best.index ? { ...it, voided: true } : it,
      );
      await tx.kdsTicket.update({
        where: { id: best.ticket.id },
        data: { itemsJson: nextItems },
      });
      // Close the struck line's station when nothing is left to cook there;
      // other stations on the card keep their own state.
      const station = String(nextItems[best.index]?.station || '')
        .trim()
        .toUpperCase();
      const stillLive = nextItems.some(
        (it: any) =>
          !it?.voided &&
          !it?.bumped &&
          (!station || String(it?.station || '').toUpperCase() === station),
      );
      if (!stillLive) {
        await tx.kdsTicketStation.updateMany({
          where: {
            ticketId: best.ticket.id,
            status: 'NEW',
            ...(station ? { station } : {}),
          },
          data: { status: 'DONE', bumpedAt: new Date() },
        });
      }
    });
    return true;
  } catch {
    return false;
  }
}
