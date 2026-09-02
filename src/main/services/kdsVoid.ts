import { prisma } from '@db/client';
import { ensureKdsLocalSchema } from './kdsSchema';

import { matchVoidableLine } from '@shared/voidLine';

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
      const order = await tx.kdsOrder.findFirst({
        where: { area, tableLabel, closedAt: null },
        orderBy: { openedAt: 'desc' },
      });
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
      await tx.kdsOrder.update({
        where: { id: order.id },
        data: { closedAt: now },
      });
    });
    return true;
  } catch {
    return false;
  }
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

      // Station routing splits one check across several KDS tickets, so pick
      // the closest match across all of them rather than the first ticket
      // that happens to hold a same-named dish.
      let best: {
        ticket: any;
        items: any[];
        index: number;
        rank: number;
      } | null = null;
      for (const t of tickets) {
        const items = Array.isArray(t.itemsJson) ? (t.itemsJson as any[]) : [];
        const match = matchVoidableLine(items, input.item);
        if (match.index === -1) continue;
        if (!best || match.rank < best.rank) {
          best = { ticket: t, items, index: match.index, rank: match.rank };
        }
      }
      if (!best) return;

      const nextItems = best.items.map((it: any, i: number) =>
        i === best!.index ? { ...it, voided: true } : it,
      );
      await tx.kdsTicket.update({
        where: { id: best.ticket.id },
        data: { itemsJson: nextItems },
      });
    });
    return true;
  } catch {
    return false;
  }
}
