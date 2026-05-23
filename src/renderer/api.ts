import { offlineQueue, tryOrQueue } from './utils/offlineQueue';

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
}

/**
 * Public renderer entry point for sending a ticket.
 *
 * - When clearly offline → enqueues directly (instant return, no
 *   awaited round-trip through a doomed network).
 * - When online → tries the live IPC, falls back to the queue ONLY on
 *   transport-shaped errors. Real validation/auth errors still
 *   surface to the caller.
 *
 * Returns a small status so callers can react to *permanent* server
 * rejections (table closed, owned by another waiter, etc.) without
 * having to catch on every site:
 *   - `{ ok: true }`         success or queued for later replay
 *   - `{ ok: false, ... }`   server rejected (toast it, undo optimistic UI)
 *
 * Generic / unknown errors are still swallowed to preserve the legacy
 * "best-effort log" semantics — the user already sees their order on
 * screen and we don't want a one-off bug to block service.
 */
export type LogTicketResult =
  | { ok: true; queued?: boolean }
  | { ok: false; error: string; code?: string };

export async function logTicket(
  payload: TicketPayload,
): Promise<LogTicketResult> {
  const normalized: TicketPayload & { covers: number | null } = {
    ...payload,
    covers: payload.covers ?? null,
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await offlineQueue.enqueue('tickets.log', normalized);
    return { ok: true, queued: true };
  }

  try {
    const r = await tryOrQueue('tickets.log', normalized);
    return { ok: true, queued: Boolean(r?.queued) };
  } catch (e: any) {
    // Server-side validation rejections (e.g. TABLE_CLOSED,
    // TABLE_OWNED_BY_OTHER) carry `permanent: true` from the
    // dispatcher. Bubble them up so the UI can show a clean toast and
    // roll back the optimistic state. Anything else is treated like
    // the legacy swallow.
    if (e?.permanent === true) {
      return {
        ok: false,
        error: String(e?.message || 'Ticket rejected by server'),
        code: e?.code ? String(e.code) : undefined,
      };
    }
    return { ok: true };
  }
}
