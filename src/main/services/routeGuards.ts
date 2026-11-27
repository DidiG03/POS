/**
 * Small decisions of the LAN routes, kept here so they can be tested
 * without a running server (busy-service run, #11 and #12).
 */

export const NO_OPEN_BILL = 'NO_OPEN_BILL';

/**
 * `/tickets/void-ticket` for a table with no sitting and not open: there is
 * nothing to void. It used to answer 200 "ok", so a phone believed it had
 * voided a bill. A table that is open but empty may still be cleared.
 */
export function voidTicketWithoutBill(input: {
  hasSitting: boolean;
  tableOpen: boolean;
}): { status: 404; body: Record<string, unknown> } | null {
  if (input.hasSitting || input.tableOpen) return null;
  return {
    status: 404,
    body: {
      ok: false,
      error:
        'This table has no open bill, so there is nothing to void. Refresh the floor.',
      code: NO_OPEN_BILL,
      permanent: true,
    },
  };
}

/**
 * Whether a payment's receipt goes to the printer. "Print receipt" off on
 * the Pay screen sends `recordOnly: true`: the sale is recorded, nothing is
 * printed. The till honoured it; the LAN route printed anyway.
 */
export function paymentReceiptPrints(input: {
  recordOnly?: unknown;
  kind: string;
}): boolean {
  return !(input.recordOnly === true && input.kind === 'PAYMENT');
}
