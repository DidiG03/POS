/**
 * What a customer-facing slip may print.
 *
 * `/print/ticket` and `tickets:print` checked kitchen slips against the
 * bill and payments against everything, but any other kind — or none —
 * printed whatever the device posted, with the venue's header and a total,
 * and left no record. A bill for anything, at any amount, could be printed
 * on a signed-in phone, the cash taken, and the sale never rung.
 *
 * Now only known kinds print. A bill (`TICKET`, the kind the apps send
 * before payment; no kind at all means the same) is built from the table's
 * own bill on the till — all of its unpaid lines, or one seat's — is
 * marked as not a receipt, and is recorded (`billEvents.ts`) so the Z
 * report and the Voids & discounts screen can show how many bills a table
 * or a waiter printed.
 */
import { asTicketLogItems } from '@shared/ticketLogItems';
import { lineIdOf, withLineIds } from '@shared/ticketLineIds';
import { findLatestTicketLogForCurrentSession } from './tableSession';

/** Kinds a device may ask the till to print. */
export const PRINTABLE_SLIP_KINDS = new Set([
  'ORDER',
  'TICKET',
  'PAYMENT',
  'RECEIPT',
]);

export const UNKNOWN_SLIP_KIND = 'UNKNOWN_SLIP_KIND';
export const NOTHING_TO_BILL = 'NOTHING_TO_BILL';
export const NOTHING_TO_BILL_MESSAGE =
  'There is nothing unpaid on this table to print a bill for.';

export function slipKindOf(meta: unknown): string {
  const kind = String((meta as any)?.kind || '')
    .trim()
    .toUpperCase();
  return kind || 'TICKET';
}

export type BillSlipCheck =
  /** Not a bill: the caller's other checks apply. */
  | { kind: 'not-bill' }
  /** Print these lines, as the till has them. */
  | { kind: 'print'; items: Record<string, unknown>[]; amount: number }
  | { kind: 'refuse'; code: string; error: string };

type Line = Record<string, unknown>;

function live(l: Line): boolean {
  return l.voided !== true && l.paid !== true && l.staged !== true;
}

/**
 * Pure core: the bill lines a slip may show. One seat's when the slip asks
 * for a seat; else the lines the device named, when it named lines the
 * bill has; else the whole unpaid bill.
 */
export function billSlipLines(
  billLines: Line[],
  requested: Line[],
  seatId: string | null,
): Line[] {
  const unpaid = billLines.filter(live);
  if (seatId) {
    return unpaid.filter((l) => String(l.seatId ?? '') === seatId);
  }
  const wanted = new Set(requested.map((l) => lineIdOf(l)).filter((id) => id));
  if (wanted.size > 0 && wanted.size === requested.length) {
    const subset = unpaid.filter((l) => wanted.has(lineIdOf(l)));
    if (subset.length === wanted.size) return subset;
  }
  return unpaid;
}

export function billSlipAmount(lines: Line[]): number {
  let sum = 0;
  for (const l of lines) {
    const qty = Number(l.qty ?? 1);
    const price = Number(l.unitPrice ?? 0);
    if (Number.isFinite(qty) && Number.isFinite(price)) sum += qty * price;
  }
  return Math.round(sum * 100) / 100;
}

export async function checkBillSlip(input: {
  area: string;
  tableLabel: string;
  meta: unknown;
  items: unknown;
}): Promise<BillSlipCheck> {
  const kind = slipKindOf(input.meta);
  if (!PRINTABLE_SLIP_KINDS.has(kind)) {
    return {
      kind: 'refuse',
      code: UNKNOWN_SLIP_KIND,
      error: `The till does not print "${kind}" slips.`,
    };
  }
  if (kind !== 'TICKET') return { kind: 'not-bill' };
  const sitting = await findLatestTicketLogForCurrentSession(
    input.area,
    input.tableLabel,
  );
  const billLines = sitting
    ? (withLineIds(asTicketLogItems((sitting as any).itemsJson) as Line[], {
        seed: (sitting as any).id,
      }) as Line[])
    : [];
  const seatId = String((input.meta as any)?.seatId ?? '').trim() || null;
  const lines = billSlipLines(
    billLines,
    Array.isArray(input.items) ? (input.items as Line[]) : [],
    seatId,
  );
  if (lines.length === 0) {
    return {
      kind: 'refuse',
      code: NOTHING_TO_BILL,
      error: NOTHING_TO_BILL_MESSAGE,
    };
  }
  return { kind: 'print', items: lines, amount: billSlipAmount(lines) };
}
