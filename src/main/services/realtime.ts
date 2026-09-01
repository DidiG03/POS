// Centralised real-time event bus for the main process.
//
// Mutations in the service layer (`services/*.ts`) should call the helpers
// here to push updates to every connected client so we never have to rely on
// polling for state that just changed locally.
//
// Two transports are wired up:
//
//   1. Electron IPC (`webContents.send`) — reaches every BrowserWindow in
//      the host process (the staff POS, Admin, KDS and Reservations
//      windows).
//   2. Server-Sent Events (`__SSE_CLIENTS__`) — reaches every Capacitor /
//      browser tablet that is currently subscribed to `GET /events`.
//
// Both transports are best-effort: an exception while writing to one
// client must not prevent the others from receiving the update, and a
// failure to broadcast must not roll back the underlying DB write.
import { BrowserWindow } from 'electron';

type SseClient = {
  res: {
    write: (chunk: string) => void;
    writableEnded?: boolean;
    destroyed?: boolean;
    writable?: boolean;
  };
};

/**
 * Push a chunk to every SSE subscriber and drop sockets that are already
 * dead. Tablets that vanish without a TCP close used to stay in the Set
 * forever (write throws, we ignored it) and collect a ping every 15s.
 */
export function writeSseToClients(
  clients: Set<SseClient>,
  chunk: string,
): void {
  for (const c of [...clients]) {
    const { res } = c;
    if (res.writableEnded || res.destroyed || res.writable === false) {
      clients.delete(c);
      continue;
    }
    try {
      c.res.write(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

/**
 * Broadcast `event: <name>\ndata: <json>\n\n` to every SSE client.
 * Dead sockets are pruned in `writeSseToClients`.
 */
let sseKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** Comment-free named ping so tablets know the SSE socket is still alive. */
export function ensureSseKeepAlive(): void {
  if (sseKeepAliveTimer) return;
  sseKeepAliveTimer = setInterval(() => {
    broadcastSse('ping', { t: Date.now() });
  }, 15_000);
  try {
    sseKeepAliveTimer.unref?.();
  } catch {
    // ignore
  }
}

function broadcastSse(eventName: string, payload: unknown): void {
  try {
    const clients: Set<SseClient> =
      (globalThis as any).__SSE_CLIENTS__ || new Set();
    const evt = `event: ${eventName}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    writeSseToClients(clients, evt);
  } catch {
    // ignore — no global SSE registry yet (server not started)
  }
}

/**
 * Send an IPC event to every Electron BrowserWindow. Renderers can listen
 * via `window.api.on(...)` (registered in preload).
 */
function broadcastIpc(channel: string, payload: unknown): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send(channel, payload);
      } catch {
        // ignore individual window failures
      }
    }
  } catch {
    // ignore — running before any window exists
  }
}

export type ReservationChangePayload = {
  /** What happened to the reservation. */
  kind: 'created' | 'updated' | 'deleted' | 'status' | 'auto-no-show';
  /** Local DB id of the reservation (or the deleted id). */
  id: number;
  /** ISO string of the reservation's local day, so listeners on a
   *  different day can ignore the event. */
  dateIso?: string;
  /** Optional area filter for cheap UI invalidation. */
  area?: string | null;
  /** Optional new status (only set when `kind === 'status'`). */
  status?: string;
};

/**
 * Notify every client that a reservation was created / updated / status
 * changed / deleted. Listeners should refetch their visible window of
 * reservations on receipt — payloads are intentionally small to keep
 * the wire chatty-cheap (no full row).
 */
export function broadcastReservationsChanged(
  payload: ReservationChangePayload,
): void {
  broadcastIpc('reservations:changed', payload);
  broadcastSse('reservations', payload);
}

export type TableStatusPayload = {
  area: string;
  label: string;
  open: boolean;
};

/**
 * Notify every client that a table's open state has changed. Used so a
 * waiter opening / closing a table on one device immediately recolours
 * the floor view on every other device (Electron windows + mobile
 * tablets). The renderer's existing `__tableStatusStore__.setOpen` call
 * keeps the wire payload identical to the prior in-line broadcast so we
 * don't break older clients that only ship the LAN HTTP `tables` event.
 */
export function broadcastTableStatusChanged(payload: TableStatusPayload): void {
  broadcastIpc('tables:changed', payload);
  // Keep the SSE event name as `tables` to match the renderer listener
  // (`es.addEventListener('tables', …)` in src/renderer/main.tsx).
  broadcastSse('tables', payload);
}

export type TicketChangePayload = {
  area: string;
  tableLabel: string;
  /** UserId that just wrote the latest ticket — sent so listeners can
   *  optimistically update the badge without re-fetching when they trust
   *  the source. Listeners that rely on display name / initials should
   *  still re-query `tickets.getLatestForTable` for the source of truth. */
  userId?: number | null;
};

/**
 * Notify every client that a new TicketLog row was written for a table.
 * Listeners use this to refresh the per-table waiter badge / metrics so
 * that when waiter A adds an item to a table that waiter B currently has
 * open, every other device sees the badge flip to A immediately instead
 * of waiting for the next 5s poll.
 */
export function broadcastTicketsChanged(payload: TicketChangePayload): void {
  broadcastIpc('tickets:changed', payload);
  // SSE event name kept lowercase singular `ticket` to match the existing
  // POST /tickets event name so clients only need one listener.
  broadcastSse('ticket', payload);
}

export type LayoutChangePayload = {
  area: string;
};

/**
 * Notify every client that the shared floor layout for an area was
 * edited (only the admin can edit). Waiter / Host floor pages refetch
 * their layout on receipt so a saved change appears on every device
 * without a refresh.
 */
export function broadcastLayoutChanged(payload: LayoutChangePayload): void {
  broadcastIpc('layout:changed', payload);
  broadcastSse('layout', payload);
}

export function broadcastTableMergesChanged(
  payload: LayoutChangePayload,
): void {
  broadcastIpc('tableMerges:changed', payload);
  broadcastSse('tableMerges', payload);
}
