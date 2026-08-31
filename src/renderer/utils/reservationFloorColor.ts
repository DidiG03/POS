/**
 * Occupancy colors on the host floor. Free / finished tables are grey —
 * never the old POS green — so Përfunduar reads as "cleared".
 */
import { reservationOccupiesTable } from '@shared/reservationDuration';

export { isLiveReservationStatus as isLiveReservation } from '@shared/reservationDuration';

export const RESERVATION_TABLE_FREE_CLASS = 'bg-zinc-600';
export const RESERVATION_TABLE_DAY_USED_CLASS = 'bg-rose-700';
/** Live seated reservation or an open POS ticket. */
export const RESERVATION_TABLE_OCCUPIED_CLASS = 'bg-rose-700';

/** Booked, seated, or completed sittings count as a use of the table that day. */
export function reservationCountsTowardDayUse(status: unknown): boolean {
  const s = String(status || '').toUpperCase();
  return s === 'BOOKED' || s === 'SEATED' || s === 'COMPLETED';
}

export function tableUseCountForDay(
  reservations: Array<{ status?: string }> | undefined,
  opts?: { openTicket?: boolean },
): number {
  const n = (reservations || []).filter((r) =>
    reservationCountsTowardDayUse(r.status),
  ).length;
  // A waiter ticket on a table that already has a sitting is the same use,
  // not a second one. Only a ticket-only table counts as 1.
  if (opts?.openTicket && n === 0) return 1;
  return n;
}

export function reservationTableColorClass(
  reservations:
    | Array<{
        status: string;
        startsAt: string;
        seatedAt?: string | null;
        durationMin?: number;
      }>
    | undefined,
  isToday: boolean,
  nowMs = Date.now(),
): string {
  const live = (reservations || []).filter((r) =>
    reservationOccupiesTable(r, nowMs),
  );
  if (!live.length) return RESERVATION_TABLE_FREE_CLASS;
  if (live.some((r) => r.status === 'SEATED'))
    return RESERVATION_TABLE_OCCUPIED_CLASS;
  const booked = live.filter((r) => r.status === 'BOOKED');
  if (!isToday) return 'bg-amber-600';
  const soon = booked.find((r) => {
    const t = new Date(r.startsAt).getTime();
    return Math.abs(t - nowMs) <= 30 * 60 * 1000;
  });
  return soon ? 'bg-blue-600' : 'bg-amber-600';
}
