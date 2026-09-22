import { coreServices, withTableLock } from './core';
import { applyTableOpenState } from './tableOpen';

export const TABLE_ALREADY_PAID = 'TABLE_ALREADY_PAID';

export type PrintTicketOk = {
  ok: true;
  printed: boolean;
  queued?: boolean;
  tableClosed?: boolean;
  /** Invoice not yet at CIS; host will transmit (48h window). */
  fiscalPending?: boolean;
  fiscalMessage?: string;
};

export type PrintTicketErr = {
  ok: false;
  code: string;
  error: string;
  permanent?: boolean;
};

export type PrintTicketResult = PrintTicketOk | PrintTicketErr;

export function paymentShouldCloseTable(meta: unknown): boolean {
  const m = (meta || {}) as {
    kind?: string;
    closeTable?: boolean;
    reprint?: boolean;
  };
  if (String(m.kind || '').toUpperCase() !== 'PAYMENT') return false;
  // Guest slip reprints from Reports must not close (or re-close) a table.
  if (m.reprint === true) return false;
  return m.closeTable !== false;
}

/** Paid-sale reprint from Reports — print only, no fiscalize / settle. */
export function isPaymentReprint(meta: unknown): boolean {
  const m = (meta || {}) as { kind?: string; reprint?: boolean };
  return String(m.kind || '').toUpperCase() === 'PAYMENT' && m.reprint === true;
}

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

/**
 * A retry that hit an existing PrintJob must still free the table when the
 * first attempt recorded the sale but died before `tables:open` was cleared.
 */
export async function closeTableAfterIdempotentPayment(
  area: string,
  label: string,
  kind: string,
  closeTable = true,
): Promise<PrintTicketOk> {
  const isPay = String(kind || '').toUpperCase() === 'PAYMENT';
  if (isPay && closeTable && area && label) {
    await withPaymentLock(area, label, async () => {
      if (await tableIsOpenForPayment(area, label)) {
        await closeTableAfterAcceptedPayment(area, label);
      }
    });
  }
  return paymentPrintAccepted(true, isPay && closeTable);
}

export function paymentPrintAccepted(
  printed: boolean,
  tableClosed = true,
  fiscal?: { fiscalPending?: boolean; fiscalMessage?: string },
): PrintTicketOk {
  return {
    ok: true,
    printed,
    queued: !printed,
    tableClosed,
    ...(fiscal?.fiscalPending
      ? {
          fiscalPending: true,
          fiscalMessage: fiscal.fiscalMessage,
        }
      : {}),
  };
}
