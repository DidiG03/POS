import { newIdempotencyKey } from './utils/idempotency';
import { tryOrQueue } from './utils/offlineQueue';

export interface TicketLinePayload {
  sku?: string;
  name: string;
  qty: number;
  unitPrice: number;
  vatRate?: number;
  note?: string;
}

export interface TicketPayload {
  userId: number;
  area: string;
  tableLabel: string;
  covers?: number | null;
  items: TicketLinePayload[];
  note?: string;
  /** Newly fired lines only — used to decrement counted low-stock without double-counting full snapshots. */
  stockConsumeLines?: { sku?: string; qty?: number }[];
  /** Newly fired lines only — appended to the open KDS ticket instead of creating a duplicate card. */
  kdsFireItems?: TicketLinePayload[];
  /**
   * Set automatically by {@link logTicket} when the caller omits it. Present so
   * a caller that owns a longer-lived intent can supply its own.
   */
  idempotencyKey?: string;
}

/**
 * Public renderer entry point for sending a ticket.
 *
 * - When online → tries the live IPC, falls back to the queue ONLY on
 *   transport-shaped errors. Real validation/auth errors still
 *   surface to the caller. `navigator.onLine` is ignored for this write:
 *   restaurant LAN still works when the tablet has no internet.
 *
 * Returns a small status so callers can react to server rejections (table
 * closed, owned by another waiter, etc.) without having to catch on every
 * site:
 *   - `{ ok: true }`         success or queued for later replay
 *   - `{ ok: false, ... }`   the order was not recorded anywhere
 */
export type LogTicketResult =
  | { ok: true; queued?: boolean }
  | { ok: false; error: string; code?: string };

export async function logTicket(
  payload: TicketPayload,
): Promise<LogTicketResult> {
  // Stamp the key before the first attempt, not on the retry. If the live call
  // reaches the host and only the response is lost, the queued replay carries
  // this same key and the host recognises it instead of sending the order to
  // the kitchen a second time.
  const normalized: TicketPayload & {
    covers: number | null;
    idempotencyKey: string;
  } = {
    ...payload,
    covers: payload.covers ?? null,
    idempotencyKey: payload.idempotencyKey || newIdempotencyKey(),
  };

  try {
    const r = await tryOrQueue('tickets.log', normalized);
    return { ok: true, queued: Boolean(r?.queued) };
  } catch (e: any) {
    // Server-side validation rejections (e.g. TABLE_CLOSED,
    // TABLE_OWNED_BY_OTHER) carry `permanent: true` from the dispatcher.
    if (e?.permanent === true) {
      return {
        ok: false,
        error: String(e?.message || 'Ticket rejected by server'),
        code: e?.code ? String(e.code) : undefined,
      };
    }
    // Anything else means `tryOrQueue` neither delivered the order nor
    // managed to queue it — a broken IndexedDB, say. Reporting success here
    // used to make the caller mark the lines as sent and print the chit, so
    // the waiter watched an order they believed was in the kitchen quietly
    // disappear with no failed-sync badge to hint at it.
    return {
      ok: false,
      error: String(e?.message || 'Could not record the order'),
      code: e?.code ? String(e.code) : 'LOG_FAILED',
    };
  }
}

/**
 * Print a kitchen/station ticket, or a full-order reprint.
 *
 * Same contract as {@link logTicket}: the key is stamped before the first
 * attempt so a lost response retries as a no-op on the host instead of
 * printing a second chit. Routed through the durable queue so a Wi-Fi drop
 * still delivers the ticket once, without the waiter tapping Send again.
 */
export async function printTicket(
  input: import('@shared/ipc').PrintTicketInput,
): Promise<{ queued: boolean }> {
  const payload = {
    ...input,
    idempotencyKey: input.idempotencyKey || newIdempotencyKey(),
  };
  const r = await tryOrQueue('tickets.print', payload);
  return { queued: Boolean(r?.queued) };
}
