/**
 * Closing a table that still has unpaid items on its bill.
 *
 * Marking a table free (`tables:setOpen` on the till, `POST /tables/open`
 * from a phone) used to do just that: it never looked at the bill, so a
 * table could be freed with items on it that were never paid, voided or
 * recorded. The apps only free a table after a payment, a void or a move,
 * and in each case the till has already closed it. A close that arrives
 * while unpaid items are still on the bill therefore did not come from the
 * normal flow. It is refused, unless an admin does it, and an admin's close
 * is recorded with the lines it left unpaid (`TABLE_CLOSED_UNPAID`).
 */
import { asTicketLogItems } from '@shared/ticketLogItems';
import { withTableLock } from './core';
import { applyTableOpenState, type SetTableOpenOptions } from './tableOpen';
import { occupancyIntentIsStale } from './tableOccupancy';
import { findLatestTicketLogForCurrentSession } from './tableSession';
import {
  billEventLines,
  billEventLinesAmount,
  recordBillEvent,
  type BillEventSource,
} from './billEvents';
import { logSecurityEvent } from './security';

export const TABLE_HAS_UNPAID = 'TABLE_HAS_UNPAID';
export const TABLE_HAS_UNPAID_MESSAGE =
  'This table still has unpaid items. Take the payment or void the items before closing it.';

export type TableCloseRefusal = {
  ok: false;
  code: typeof TABLE_HAS_UNPAID;
  error: string;
  permanent: true;
};

type Line = Record<string, unknown>;

/** Lines still owed on the bill: not voided, not paid, with a quantity. */
export function unpaidBillLines(items: unknown): Line[] {
  return (asTicketLogItems(items) as Line[]).filter((l) => {
    if (!l || l.voided === true || l.paid === true) return false;
    const qty = Number(l.qty ?? 1);
    return Number.isFinite(qty) && qty > 0;
  });
}

export interface SetTableOpenGuardedInput {
  area: string;
  label: string;
  open: boolean;
  options?: SetTableOpenOptions;
  /** Who asked. Null when the till cannot tell (no session). */
  actor: { userId: number; role: string } | null;
  source: BillEventSource;
}

/**
 * `setTableOpenWithSideEffects`, refusing to free a table with unpaid lines
 * unless the actor is an admin. True when applied (or stale, which is
 * settled), or the refusal.
 */
export async function setTableOpenGuarded(
  input: SetTableOpenGuardedInput,
): Promise<true | TableCloseRefusal> {
  const { area, label, open } = input;
  if (!area || !label) return true;
  return withTableLock(area, label, async () => {
    if (!open) {
      const stale = await occupancyIntentIsStale(
        area,
        label,
        input.options?.intentAt ?? null,
      );
      // A stale close changes nothing, so there is nothing to check.
      if (!stale) {
        const sitting = await findLatestTicketLogForCurrentSession(area, label);
        const unpaid = unpaidBillLines((sitting as any)?.itemsJson);
        if (unpaid.length > 0) {
          const isAdmin =
            String(input.actor?.role || '').toUpperCase() === 'ADMIN';
          if (!isAdmin) {
            logSecurityEvent('table_close_refused_unpaid', {
              userId: input.actor?.userId ?? null,
              area,
              tableLabel: label,
              source: input.source,
              unpaidLines: unpaid.length,
            });
            return {
              ok: false as const,
              code: TABLE_HAS_UNPAID,
              error: TABLE_HAS_UNPAID_MESSAGE,
              permanent: true as const,
            };
          }
          const lines = billEventLines(unpaid);
          const applied = await applyTableOpenState(
            area,
            label,
            false,
            input.options,
          );
          if (applied) {
            await recordBillEvent({
              kind: 'TABLE_CLOSED_UNPAID',
              area,
              tableLabel: label,
              actorUserId: input.actor?.userId ?? null,
              amount: billEventLinesAmount(lines),
              source: input.source,
              details: {
                lines,
                tableOwnerId: Number((sitting as any)?.userId) || null,
              },
            });
          }
          return true as const;
        }
      }
    }
    await applyTableOpenState(area, label, open, input.options);
    return true as const;
  });
}
