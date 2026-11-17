import { coreServices, withTableLock } from './core';
import { applyTableOpenState } from './tableOpen';
import { recordPaidLinesOnBill } from './paidLines';
import { getOpenedAt } from './tableOccupancy';

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

/**
 * Work a payment hands back to run once the table lock is released.
 *
 * The lock used to be held through the receipt print as well, so a slow or
 * unreachable printer kept every other device off that table ("table is
 * busy", Audit M3). The sale is recorded and the table settled under the
 * lock; printing then runs outside it.
 */
export class AfterPaymentLock<T> {
  constructor(readonly run: () => Promise<T>) {}
}

export function afterPaymentLock<T>(
  run: () => Promise<T>,
): AfterPaymentLock<T> {
  return new AfterPaymentLock(run);
}

/** Run what a payment step returned: its result, or its after-lock work. */
export async function finishAfterPaymentLock<T>(
  out: T | AfterPaymentLock<T>,
): Promise<T> {
  return out instanceof AfterPaymentLock ? await out.run() : out;
}

/** `withPaymentLock`, then any after-lock work outside the lock. */
export async function withPaymentLockThen<T>(
  area: string,
  label: string,
  fn: () => Promise<T | AfterPaymentLock<T>>,
): Promise<T> {
  return finishAfterPaymentLock(await withPaymentLock(area, label, fn));
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
 * After a payment is recorded: close the table, or (a seat's share, table
 * left open) flag the lines it paid on the bill (`paidLines.ts`). Must run
 * while holding `withTableLock` for this table, before the lock is released,
 * so no Send can land between the sale and the bill knowing about it.
 */
export async function settleTableAfterPayment(input: {
  area: string;
  tableLabel: string;
  closeTable: boolean;
  items: unknown[];
  userId: number;
  paymentKey?: string | null;
}): Promise<void> {
  if (input.closeTable) {
    await closeTableAfterAcceptedPayment(input.area, input.tableLabel);
    return;
  }
  await recordPaidLinesOnBill({
    area: input.area,
    tableLabel: input.tableLabel,
    items: input.items,
    userId: input.userId,
    paymentKey: input.paymentKey,
  }).catch((e) => {
    console.warn('[payment] could not flag paid lines on the bill:', e);
  });
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
  opts?: { lockHeld?: boolean },
): Promise<PrintTicketOk> {
  const isPay = String(kind || '').toUpperCase() === 'PAYMENT';
  if (isPay && closeTable && area && label) {
    const close = async () => {
      if (await tableIsOpenForPayment(area, label)) {
        await closeTableAfterAcceptedPayment(area, label);
      }
    };
    // A caller already holding this table's lock must not take it again.
    if (opts?.lockHeld) await close();
    else await withPaymentLock(area, label, close);
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

export const PAYMENT_KEY_REUSED = 'PAYMENT_KEY_REUSED';

type StoredJob = {
  createdAt?: unknown;
  payloadJson?: unknown;
};

/**
 * Answer a request whose idempotency key the till has already recorded.
 *
 * The answer used to close the table named in the new request, taking the
 * kind and close flag from it too, so any key a phone had used before (a
 * payment, even a kitchen slip) freed any table with its items unpaid.
 * Now only what is stored under the key counts:
 *   - a request naming another table is refused, and nothing is done;
 *   - the stored job's table is closed only when the stored job is a
 *     payment that closed it, and only when the table's current sitting
 *     began before that payment: a late retry must not close the next
 *     party's table.
 */
export async function answerRecordedRequest(
  existing: StoredJob,
  requested: { area?: unknown; tableLabel?: unknown },
  opts?: { lockHeld?: boolean },
): Promise<PrintTicketOk | PrintTicketErr> {
  const payload = (existing?.payloadJson || {}) as {
    area?: unknown;
    tableLabel?: unknown;
    meta?: unknown;
  };
  const area = String(payload.area ?? '').trim();
  const label = String(payload.tableLabel ?? '').trim();
  const askedArea = String(requested.area ?? '').trim();
  const askedLabel = String(requested.tableLabel ?? '').trim();
  if (
    (askedArea && askedArea !== area) ||
    (askedLabel && askedLabel !== label)
  ) {
    return {
      ok: false,
      code: PAYMENT_KEY_REUSED,
      error:
        'This request was already used for another table. Nothing was done; refresh the table and try again.',
      permanent: true,
    };
  }
  const meta = payload.meta as { kind?: unknown } | undefined;
  const kind = String(meta?.kind || '');
  const closes = paymentShouldCloseTable(meta);
  if (closes && area && label) {
    const openedAt = await getOpenedAt(area, label).catch(() => null);
    const paidAt = new Date(existing?.createdAt as any).getTime();
    if (openedAt && Number.isFinite(paidAt) && openedAt.getTime() > paidAt) {
      // A new party sat down after this payment: leave their table alone.
      return paymentPrintAccepted(true, false);
    }
  }
  return closeTableAfterIdempotentPayment(area, label, kind, closes, opts);
}
