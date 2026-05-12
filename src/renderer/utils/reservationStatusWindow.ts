import type { ReservationStatus } from '@shared/ipc';

/** Earliest moment SEATED / COMPLETED / NO_SHOW may be applied. CANCELLED stays available anytime. */
export const RESERVATION_QUICK_STATUS_LEAD_MS = 15 * 60 * 1000;

const GATED_QUICK_STATUSES: ReservationStatus[] = [
  'SEATED',
  'COMPLETED',
  'NO_SHOW',
];

export function isReservationQuickStatusTooEarly(
  nowMs: number,
  startsAtIso: string,
  targetStatus: ReservationStatus,
): boolean {
  if (!GATED_QUICK_STATUSES.includes(targetStatus)) return false;
  const startMs = new Date(startsAtIso).getTime();
  if (!Number.isFinite(startMs)) return false;
  return nowMs < startMs - RESERVATION_QUICK_STATUS_LEAD_MS;
}

export function reservationQuickStatusUnlockHint(startsAtIso: string): string {
  const startMs = new Date(startsAtIso).getTime();
  if (!Number.isFinite(startMs)) return '';
  const unlock = new Date(startMs - RESERVATION_QUICK_STATUS_LEAD_MS);
  return unlock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
