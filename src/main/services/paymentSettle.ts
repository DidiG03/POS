import { coreServices, withTableLock } from './core';
import { applyTableOpenState } from './tableOpen';

export const TABLE_ALREADY_PAID = 'TABLE_ALREADY_PAID';

export type PrintTicketOk = {
  ok: true;
  printed: boolean;
  queued?: boolean;
  tableClosed?: boolean;
};

export type PrintTicketErr = {
  ok: false;
  code: string;
  error: string;
  permanent?: boolean;
};

export type PrintTicketResult = PrintTicketOk | PrintTicketErr;

export function tableAlreadyPaidResult(): PrintTicketErr {
  return {
    ok: false,
    code: TABLE_ALREADY_PAID,
    error: 'This table was already paid or closed.',
  };
}

/**
 * Serialize a payment for one table so two waiters cannot fiscalize
 * the same sitting with two different idempotency keys.
 *
 * Callers already inside `withTableLock` for this table must use
 * {@link applyTableOpenState} directly — taking the lock twice deadlocks.
 */
export async function withPaymentLock<T>(
  area: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withTableLock(area, label, fn);
}

export async function tableIsOpenForPayment(
  area: string,
  label: string,
): Promise<boolean> {
  return coreServices.isTableOpen(area, label);
}

/** Must run while holding `withTableLock` for this table. */
export async function closeTableAfterAcceptedPayment(
  area: string,
  label: string,
): Promise<void> {
  await applyTableOpenState(area, label, false);
}

export function paymentPrintAccepted(printed: boolean): PrintTicketOk {
  return {
    ok: true,
    printed,
    queued: !printed,
    tableClosed: true,
  };
}
