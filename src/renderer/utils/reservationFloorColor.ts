/**
 * Occupancy colors on the host floor. Free / finished tables are grey —
 * never the old POS green — so Përfunduar reads as "cleared".
 */
import { reservationOccupiesTable } from '@shared/reservationDuration';

export { isLiveReservationStatus as isLiveReservation } from '@shared/reservationDuration';

export const RESERVATION_TABLE_FREE_CLASS = 'bg-zinc-600';

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
  if (live.some((r) => r.status === 'SEATED')) return 'bg-rose-700';
  const booked = live.filter((r) => r.status === 'BOOKED');
  if (!isToday) return 'bg-amber-600';
  const soon = booked.find((r) => {
    const t = new Date(r.startsAt).getTime();
    return Math.abs(t - nowMs) <= 30 * 60 * 1000;
  });
  return soon ? 'bg-blue-600' : 'bg-amber-600';
}
