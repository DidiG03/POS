import { prisma } from '@db/client';
import { ensureKdsLocalSchema } from './kdsSchema';

function itemMatchesVoidTarget(it: any, item: any): boolean {
  const sku = String(item?.sku || '').trim();
  const name = String(item?.name || '').trim();
  const itSku = String(it?.sku || '').trim();
  const itName = String(it?.name || '').trim();
  return (sku && itSku && itSku === sku) || itName === name;
}

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
      let voidedOne = false;
      for (const t of tickets) {
        if (voidedOne) break;
        const itemsAll = Array.isArray(t.itemsJson)
          ? (t.itemsJson as any[])
          : [];
        let changed = false;
        const nextItems = itemsAll.map((it: any) => {
          if (voidedOne || it?.voided) return it;
          if (itemMatchesVoidTarget(it, input.item)) {
            voidedOne = true;
            changed = true;
            return { ...it, voided: true };
          }
          return it;
        });
        if (changed) {
          await tx.kdsTicket.update({
            where: { id: t.id },
            data: { itemsJson: nextItems },
          });
        }
      }
    });
    return true;
  } catch {
    return false;
  }
}
