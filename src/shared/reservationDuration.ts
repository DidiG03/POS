/** BOOKED / SEATED hold a table; everything else is history. */
export function isLiveReservationStatus(status: string): boolean {
  return status === 'BOOKED' || status === 'SEATED';
}

/** Host-facing Kohëzgjatja chips: 1h, 1:30h, 2h, 3h. */
export const RESERVATION_DURATION_PRESETS: ReadonlyArray<{
  mins: number;
  label: string;
}> = [
  { mins: 60, label: '1h' },
  { mins: 90, label: '1:30h' },
  { mins: 120, label: '2h' },
  { mins: 180, label: '3h' },
];

export const DEFAULT_RESERVATION_DURATION_MIN = 90;

export function formatReservationDuration(mins: number): string {
  const n = Math.round(Number(mins) || 0);
  const preset = RESERVATION_DURATION_PRESETS.find((p) => p.mins === n);
  if (preset) return preset.label;
  if (n <= 0) return '';
  if (n % 60 === 0) return `${n / 60}h`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}h` : `${m}m`;
}

export function reservationEndMs(
  startsAt: string | Date,
  durationMin?: number,
): number | null {
  const start =
    startsAt instanceof Date
      ? startsAt.getTime()
      : Date.parse(String(startsAt));
  if (!Number.isFinite(start)) return null;
  const dur = Number(durationMin);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  return start + dur * 60_000;
}

/**
 * True while a live reservation still owns the table.
 * After `startsAt + Kohëzgjatja` the slot is over even if nobody tapped
 * Përfunduar. Missing / zero duration keeps occupying until a manual
 * status change (legacy rows that never stored a length).
 */
export function reservationOccupiesTable(
  r: { status: string; startsAt: string | Date; durationMin?: number },
  nowMs = Date.now(),
): boolean {
  if (!isLiveReservationStatus(r.status)) return false;
  const start =
    r.startsAt instanceof Date
      ? r.startsAt.getTime()
      : Date.parse(String(r.startsAt));
  if (!Number.isFinite(start)) return false;
  const dur = Number(r.durationMin);
  if (!Number.isFinite(dur) || dur <= 0) return true;
  return nowMs < start + dur * 60_000;
}

/**
 * What the host should see. A seated party whose Kohëzgjatja has elapsed is
 * Përfunduar even if the row has not been written yet.
 */
export function effectiveReservationStatus(
  r: { status: string; startsAt: string | Date; durationMin?: number },
  nowMs = Date.now(),
): string {
  if (r.status === 'SEATED' && !reservationOccupiesTable(r, nowMs)) {
    return 'COMPLETED';
  }
  return r.status;
}
