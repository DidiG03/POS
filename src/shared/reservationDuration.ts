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

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

export function formatReservationClock(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
}

/**
 * Seated clock when it differs from the booked slot by at least a minute.
 * Walk-ins (seated at the booked time) return null so the UI stays a single time.
 */
export function distinctSeatedAt(
  startsAt: string | Date,
  seatedAt?: string | Date | null,
): Date | null {
  if (seatedAt == null || seatedAt === '') return null;
  const booked = toMs(startsAt);
  const seated = toMs(seatedAt);
  if (!Number.isFinite(booked) || !Number.isFinite(seated)) return null;
  if (Math.abs(booked - seated) < 60_000) return null;
  return new Date(seated);
}

export function reservationEndMs(
  startsAt: string | Date,
  durationMin?: number,
): number | null {
  const start = toMs(startsAt);
  if (!Number.isFinite(start)) return null;
  const dur = Number(durationMin);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  return start + dur * 60_000;
}

export type ReservationHold = {
  status: string;
  startsAt: string | Date;
  seatedAt?: string | Date | null;
  durationMin?: number;
};

/** BOOKED holds from the slot; SEATED holds from when they actually sat. */
export function reservationOccupancyStartMs(r: ReservationHold): number | null {
  const booked = toMs(r.startsAt);
  if (!Number.isFinite(booked)) return null;
  if (r.status === 'SEATED' && r.seatedAt) {
    const seated = toMs(r.seatedAt);
    if (Number.isFinite(seated)) return seated;
  }
  return booked;
}

/** Extra minutes added when the host taps Extend time after a stay elapses. */
export const RESERVATION_STAY_EXTENSION_MIN = 30;

function occupancyDurationMin(r: ReservationHold): number {
  const dur = Number(r.durationMin);
  if (Number.isFinite(dur) && dur > 0) return dur;
  // Legacy rows with no Kohëzgjatja used to occupy forever, which blocked
  // merging tables that the floor already showed as free. Hold the default
  // stay instead so a finished party does not keep the table seated.
  return DEFAULT_RESERVATION_DURATION_MIN;
}

/**
 * True while a live reservation still owns the table.
 * BOOKED holds until the slot ends. SEATED holds until the stay elapses —
 * after that the time-up prompt asks the host to extend or free it, and the
 * table is treated as free so it can be merged or reseated.
 */
export function reservationOccupiesTable(
  r: ReservationHold,
  nowMs = Date.now(),
): boolean {
  if (!isLiveReservationStatus(r.status)) return false;
  const start = reservationOccupancyStartMs(r);
  if (start == null) return false;
  return nowMs < start + occupancyDurationMin(r) * 60_000;
}

/**
 * Seated party whose Kohëzgjatja has run out. The table stays occupied
 * until the host extends or frees it.
 */
export function reservationStayElapsed(
  r: ReservationHold,
  nowMs = Date.now(),
): boolean {
  if (r.status !== 'SEATED') return false;
  const start = reservationOccupancyStartMs(r);
  if (start == null) return false;
  return nowMs >= start + occupancyDurationMin(r) * 60_000;
}

/** Display status matches the stored row; elapsed stays are still Ulur. */
export function effectiveReservationStatus(
  r: ReservationHold,
  _nowMs = Date.now(),
): string {
  void _nowMs;
  return r.status;
}
