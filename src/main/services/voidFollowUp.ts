/**
 * What happens around a void besides the bill: the kitchen and the owner.
 *
 * Voids only updated the KDS. A kitchen working from printed slips kept
 * cooking a cancelled dish, and the waiter whose table it was never heard
 * that a colleague (or a manager) had taken an item off their bill.
 */
import { prisma } from '@db/client';
import { coreServices } from './core';
import { fireDispatchTicket } from './printDispatcher';
import { getCurrentSessionOwnerId } from './tableSession';

/** Lines that went to the kitchen (a printed or KDS slip exists for them). */
export function linesTheKitchenHas(lines: unknown[]): any[] {
  return (Array.isArray(lines) ? lines : []).filter(
    (l: any) =>
      l &&
      l.fired !== false &&
      l.staged !== true &&
      l.paid !== true &&
      String(l.name || '').trim(),
  );
}

/**
 * Print a VOID (one line) or ORDER CANCELLED (whole ticket) slip to the
 * station printers the lines were routed to, through the same routing and
 * retry queue as the order slip.
 */
export async function printVoidSlip(input: {
  area: string;
  tableLabel: string;
  lines: unknown[];
  actorUserId: number;
  whole: boolean;
  reason?: string | null;
}): Promise<void> {
  const lines = linesTheKitchenHas(input.lines);
  if (!lines.length) return;
  try {
    const settings = await coreServices.readSettings();
    const actor = await prisma.user
      .findUnique({ where: { id: Number(input.actorUserId) } })
      .catch(() => null);
    fireDispatchTicket(
      {
        area: input.area,
        tableLabel: input.tableLabel,
        covers: null,
        items: lines.map((l: any) => ({
          sku: l.sku,
          name: String(l.name),
          qty: Number(l.qty) || 1,
          unitPrice: 0,
          note: l.note || undefined,
        })),
        note: input.reason ? String(input.reason) : null,
        userName: (actor as any)?.displayName || undefined,
        meta: {
          kind: 'ORDER',
          voidSlip: input.whole ? 'TICKET' : 'ITEM',
          userId: Number(input.actorUserId) || undefined,
          hidePrices: true,
        },
      } as any,
      settings as any,
      { persistRetryOnTransientFailure: true },
    );
  } catch (e) {
    console.warn('[void] void slip not printed', e);
  }
}

/**
 * Tell the table's waiter when someone else voided on their table. The
 * actor and admins already get the audit notification.
 */
export async function notifyOwnerOfVoid(input: {
  area: string;
  tableLabel: string;
  actorUserId: number;
  message: string;
  /** The owner read before the void (a ticket void closes the sitting). */
  ownerId?: number | null;
}): Promise<void> {
  const ownerId =
    input.ownerId !== undefined
      ? input.ownerId
      : await getCurrentSessionOwnerId(input.area, input.tableLabel).catch(
          () => null,
        );
  if (!ownerId || Number(ownerId) === Number(input.actorUserId)) return;
  const actor = await prisma.user
    .findUnique({ where: { id: Number(input.actorUserId) } })
    .catch(() => null);
  const who = (actor as any)?.displayName || `#${input.actorUserId}`;
  await prisma.notification
    .create({
      data: {
        userId: Number(ownerId),
        type: 'OTHER' as any,
        message: `${who} on your table: ${input.message}`,
      } as any,
    })
    .catch(() => undefined);
}
