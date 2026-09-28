/**
 * Admin alert for a table the host auto-voids after 12 hours.
 *
 * The auto-void keeps the floor clean after long downtime, but it also
 * erases an order that was never paid — and "serve, take cash, never press
 * Pay" is exactly how money leaves a venue without reaching fiskalizimi. The
 * void used to tell only the waiter who owned the table. Admins now get the
 * table, the waiter and the unpaid value, so an unpaid ticket can never
 * disappear quietly.
 */

import { notifyAdminsAndActor } from './adminAlerts';
import { roundMoney } from '@shared/pricing';

type TicketLine = {
  name?: unknown;
  qty?: unknown;
  unitPrice?: unknown;
  voided?: unknown;
  paid?: unknown;
};

/** Items still owed on a ticket snapshot: not voided and not already paid. */
export function unpaidTicketValue(items: unknown): {
  count: number;
  value: number;
} {
  const lines = Array.isArray(items) ? (items as TicketLine[]) : [];
  let count = 0;
  let value = 0;
  for (const line of lines) {
    if (!line || line.voided === true || line.paid === true) continue;
    const qty = Number(line.qty);
    const price = Number(line.unitPrice);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) continue;
    count += 1;
    value += qty * price;
  }
  return { count, value: roundMoney(value) };
}

export function autoVoidAlertMessage(input: {
  area: string;
  tableLabel: string;
  count: number;
  value: number;
  currency: string;
  waiterName?: string | null;
  openedAt?: Date | null;
}): string {
  const where = [input.area, `Table ${input.tableLabel}`]
    .filter(Boolean)
    .join(' ');
  const opened = input.openedAt
    ? ` (open since ${input.openedAt.toLocaleString()})`
    : '';
  const waiter = input.waiterName ? `, waiter ${input.waiterName}` : '';
  return (
    `Auto-voided ${where}${opened}${waiter}: ${input.count} unpaid item(s) worth ` +
    `${input.value.toFixed(2)} ${input.currency} were never paid and never reported to fiskalizimi.` +
    ' If the guest did pay, that sale is missing from the tax records — check with the waiter.'
  );
}

/**
 * Tell admins (and the owning waiter) what an auto-void removed. Returns
 * false when nothing unpaid was on the ticket, in which case there is
 * nothing to report.
 */
export async function notifyAutoVoidedTable(input: {
  area: string;
  tableLabel: string;
  items: unknown;
  currency: string;
  actorUserId?: number;
  waiterName?: string | null;
  openedAt?: Date | null;
}): Promise<boolean> {
  const { count, value } = unpaidTicketValue(input.items);
  if (count === 0) return false;
  await notifyAdminsAndActor({
    message: autoVoidAlertMessage({
      area: input.area,
      tableLabel: input.tableLabel,
      count,
      value,
      currency: input.currency,
      waiterName: input.waiterName,
      openedAt: input.openedAt,
    }),
    actorUserId: input.actorUserId,
    type: 'SECURITY',
  }).catch(() => undefined);
  return true;
}
