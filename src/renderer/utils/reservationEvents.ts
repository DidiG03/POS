// Renderer-side helper to fan out reservation-change notifications on the
// same device that just mutated a reservation. The main process already
// broadcasts the same event to every client over SSE/IPC (see
// `services/realtime.ts → broadcastReservationsChanged`), but EventSource
// connections can be silently down (Android background kill, Wi-Fi flap,
// dev server restart), so we never want the tablet/window that made the
// change to depend on the broadcast loop for its own UI refresh.
//
// Pages listen for the same `pos:reservationsChanged` window event the
// SSE / IPC bridge dispatches, so calling `dispatchReservationsChanged`
// after a successful mutation is enough to refresh the visible day.

export type ReservationsChangedKind =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'status'
  | 'auto-no-show';

export interface ReservationsChangedDetail {
  kind: ReservationsChangedKind;
  /** Reservation id, when known. Deletes still get a numeric id from the
   *  service; same-device callers can omit it for "refresh, but I don't
   *  know which row." */
  id?: number;
  /** ISO of the reservation's local day; listeners filter by day to avoid
   *  refetching unrelated days. When unknown, listeners refetch regardless. */
  dateIso?: string | null;
  /** Optional area filter — Floor view ignores events for other areas. */
  area?: string | null;
  /** Optional new status (only set when `kind === 'status'`). */
  status?: string;
}

/** Fire the standard `pos:reservationsChanged` window event with the
 *  given payload. Safe to call from any renderer (Electron window or
 *  Capacitor WebView); listeners are identical in both. */
export function dispatchReservationsChanged(
  detail: ReservationsChangedDetail,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('pos:reservationsChanged', { detail }),
    );
  } catch {
    // Older WebViews without CustomEvent constructor fall back to Event,
    // which still fires our listeners — they only read `detail` defensively.
    try {
      window.dispatchEvent(new Event('pos:reservationsChanged'));
    } catch {
      // ignore — nothing else we can usefully do
    }
  }
}
