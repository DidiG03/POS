/**
 * A kitchen/bar slip (`kind: 'ORDER'`) prints what its Send put on the bill.
 *
 * The slip used to print whatever lines the device posted, whether or not
 * the Send had landed. A keyless Send after a void was folded into the
 * voided line: the slip came out, the guest was never billed for it, and
 * stock never counted it. Now the slip is looked up on the bill by its Send
 * key (`meta.sendKey`, stamped on every line that Send fired) and prints
 * those lines, as the till recorded them. No key, or nothing live on the
 * bill under it: no slip.
 */
import { asTicketLogItems } from '@shared/ticketLogItems';
import { findLatestTicketLogForCurrentSession } from './tableSession';

export const ORDER_NOT_ON_BILL_MESSAGE =
  'This order is not on the bill, so it was not sent to the kitchen. Send the order again.';

export type OrderSlipCheck =
  /** Not a kitchen slip: print as asked. */
  | { kind: 'not-order' }
  /** Print these lines: what the Send put on the bill. */
  | { kind: 'print'; items: Record<string, unknown>[] }
  /** Refuse: nothing on the bill for this Send. */
  | { kind: 'refuse'; code: 'ORDER_NOT_ON_BILL'; error: string };

export async function checkOrderSlip(input: {
  area: string;
  tableLabel: string;
  meta: unknown;
}): Promise<OrderSlipCheck> {
  const meta = (input.meta || {}) as Record<string, unknown>;
  if (String(meta.kind || '').toUpperCase() !== 'ORDER') {
    return { kind: 'not-order' };
  }
  const refuse = {
    kind: 'refuse' as const,
    code: 'ORDER_NOT_ON_BILL' as const,
    error: ORDER_NOT_ON_BILL_MESSAGE,
  };
  const sendKey = String(meta.sendKey ?? '').trim();
  if (!sendKey) return refuse;
  const latest = await findLatestTicketLogForCurrentSession(
    input.area,
    input.tableLabel,
  ).catch(() => null);
  const items = (
    latest ? asTicketLogItems((latest as any).itemsJson) : []
  ) as Record<string, unknown>[];
  const lines = items.filter(
    (l) =>
      l &&
      String(l.sendKey ?? '').trim() === sendKey &&
      l.voided !== true &&
      l.paid !== true &&
      l.fired !== false,
  );
  return lines.length ? { kind: 'print', items: lines } : refuse;
}
