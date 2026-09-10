/**
 * A paid line is out of the waiter's reach.
 *
 * Once money has been taken the sale is settled and, with fiskalizimi on, an
 * invoice for it sits with the tax service. Striking the line off the ticket
 * afterwards does not undo either one: the till keeps the cash, the filed
 * invoice keeps the item, and the only lawful way back is a cancellation or
 * corrective invoice — an admin job, not a manager-PIN job at the table.
 *
 * Unpaid lines are untouched by this rule. A waiter can still void what the
 * kitchen is cooking, with the manager PIN, including on a table where other
 * seats have already paid.
 */
import { matchVoidableLine, type VoidTargetLine } from './voidLine';

export function isPaidTicketLine(line: unknown): boolean {
  return (line as { paid?: unknown } | null | undefined)?.paid === true;
}

function isLiveTicketLine(line: unknown): boolean {
  return (line as { voided?: unknown } | null | undefined)?.voided !== true;
}

export function hasPaidTicketLines(
  items: readonly unknown[] | null | undefined,
): boolean {
  return (Array.isArray(items) ? items : []).some(isPaidTicketLine);
}

export type ItemVoidPlan =
  /** Void this index. */
  | { outcome: 'ok'; index: number }
  /** The line the waiter picked has been paid for. Refuse. */
  | { outcome: 'paid' }
  /** Nothing on the ticket matches. */
  | { outcome: 'not-found' };

export function planItemVoid(
  items: readonly unknown[] | null | undefined,
  target: VoidTargetLine | null | undefined,
): ItemVoidPlan {
  const list = Array.isArray(items) ? items : [];
  // Hiding paid lines behind the existing "already voided" rule keeps the
  // indexes aligned with the caller's array while steering the match to a
  // line that may still be voided.
  const unpaidOnly = list.map((line) =>
    isPaidTicketLine(line) ? { ...(line as object), voided: true } : line,
  );
  const unpaid = matchVoidableLine(unpaidOnly, target);
  if (unpaid.index !== -1) return { outcome: 'ok', index: unpaid.index };

  const anyLine = matchVoidableLine(list, target);
  if (anyLine.index !== -1 && isPaidTicketLine(list[anyLine.index])) {
    return { outcome: 'paid' };
  }
  return { outcome: 'not-found' };
}

export type TicketVoidPlan<T> =
  /** Write these items back; `voidedCount` lines were struck. */
  | { outcome: 'ok'; items: T[]; voidedCount: number; keptPaidCount: number }
  /** Everything still standing on this ticket is paid for. Refuse. */
  | { outcome: 'paid' };

export function planTicketVoid<T>(
  items: readonly T[] | null | undefined,
): TicketVoidPlan<T> {
  const list = Array.isArray(items) ? items : [];
  const paid = list.filter(isPaidTicketLine);
  const voidable = list.filter(
    (line) => !isPaidTicketLine(line) && isLiveTicketLine(line),
  );
  if (voidable.length === 0 && paid.length > 0) return { outcome: 'paid' };

  return {
    outcome: 'ok',
    items: list.map((line) =>
      isPaidTicketLine(line)
        ? line
        : ({ ...(line as object), voided: true } as T),
    ),
    voidedCount: voidable.length,
    keptPaidCount: paid.length,
  };
}
