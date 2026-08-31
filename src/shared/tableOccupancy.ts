import {
  reservationEndMs,
  reservationOccupancyStartMs,
  reservationOccupiesTable,
} from './reservationDuration';

export type OccupancyReservation = {
  id?: number;
  area: string;
  tableLabel: string | null;
  status: string;
  startsAt: string;
  seatedAt?: string | null;
  durationMin?: number;
};

export function tableOccupancyKey(area: string, label: string): string {
  return `${String(area || '').trim()}:${String(label || '').trim()}`;
}

/**
 * True when an update keeps the reservation on the same table it already
 * holds. Used so a waiter opening a ticket on a seated party is the same
 * sitting — not a conflict that blocks editing or seating.
 */
export function reservationKeepsTableAssignment(
  existing:
    | { area?: string | null; tableLabel?: string | null }
    | null
    | undefined,
  next: { area: string; tableLabel: string | null },
): boolean {
  if (!existing) return false;
  const nextLabel = String(next.tableLabel || '').trim();
  if (!nextLabel) return false;
  return (
    String(existing.area || '').trim() === String(next.area || '').trim() &&
    String(existing.tableLabel || '').trim() === nextLabel
  );
}

/** True when `instantMs` falls inside the proposed [start, start+duration). */
export function occupancyOverlapsInstant(
  startsAt: string | Date | number,
  durationMin: number | undefined,
  instantMs: number,
): boolean {
  const start =
    typeof startsAt === 'number'
      ? startsAt
      : startsAt instanceof Date
        ? startsAt.getTime()
        : Date.parse(String(startsAt));
  if (!Number.isFinite(start)) return false;
  const dur = Math.max(15, Math.min(720, Number(durationMin) || 90)) * 60_000;
  return start <= instantMs && instantMs < start + dur;
}

export function liveOccupyingTableKeys(
  reservations: OccupancyReservation[],
  nowMs: number,
): Set<string> {
  const keys = new Set<string>();
  for (const r of reservations) {
    if (!r.tableLabel) continue;
    if (reservationOccupiesTable(r, nowMs)) {
      keys.add(tableOccupancyKey(r.area, r.tableLabel));
    }
  }
  return keys;
}

/** Matches a generous early-arrival window (not only the floor “soon” chip). */
export const OPEN_TICKET_BOOKING_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * A waiter ticket is the same sitting as a reservation when that party is
 * at the table: seated, or booked and within the soon window / slot.
 * A later booking tonight stays a separate row.
 */
export function reservationCoversOpenTicket(
  r: OccupancyReservation,
  nowMs: number,
): boolean {
  if (!r.tableLabel) return false;
  if (!reservationOccupiesTable(r, nowMs)) return false;
  if (r.status === 'SEATED') return true;
  if (r.status === 'BOOKED') {
    const start = reservationOccupancyStartMs(r);
    if (start == null) return false;
    return nowMs >= start - OPEN_TICKET_BOOKING_GRACE_MS;
  }
  return false;
}

export function ticketCoveringTableKeys(
  reservations: OccupancyReservation[],
  nowMs: number,
): Set<string> {
  const keys = new Set<string>();
  for (const r of reservations) {
    if (!r.tableLabel) continue;
    if (reservationCoversOpenTicket(r, nowMs)) {
      keys.add(tableOccupancyKey(r.area, r.tableLabel));
    }
  }
  return keys;
}

/** Open POS tickets that are not already the same sitting as a live reservation. */
export function uncoveredOpenTickets(
  openTables: Array<{ area: string; label: string }>,
  liveKeys: Set<string>,
): Array<{ area: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ area: string; label: string }> = [];
  for (const t of openTables) {
    const area = String(t.area || '').trim();
    const label = String(t.label || '').trim();
    if (!area || !label) continue;
    const key = tableOccupancyKey(area, label);
    if (liveKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ area, label });
  }
  return out;
}

export function reservationHasOpenTicket(
  r: OccupancyReservation,
  openTables: Array<{ area: string; label: string }>,
  nowMs: number,
): boolean {
  if (!r.tableLabel) return false;
  if (!reservationCoversOpenTicket(r, nowMs)) return false;
  const key = tableOccupancyKey(r.area, r.tableLabel);
  return openTables.some((t) => tableOccupancyKey(t.area, t.label) === key);
}

/** How long after the planned stay a payment still counts as that sitting. */
export const PAID_TICKET_AFTER_GRACE_MS = 4 * 60 * 60 * 1000;

export type PaidPosTable = {
  area: string;
  label: string;
  paidAt: string;
};

function sameReservationRow(
  a: OccupancyReservation,
  b: OccupancyReservation,
): boolean {
  if (a.id != null && b.id != null) return a.id === b.id;
  return a === b;
}

function nextSittingStartMs(
  r: OccupancyReservation,
  siblings: OccupancyReservation[],
): number | null {
  const start = reservationOccupancyStartMs(r);
  if (start == null || !r.tableLabel) return null;
  const key = tableOccupancyKey(r.area, r.tableLabel);
  let next: number | null = null;
  for (const s of siblings) {
    if (sameReservationRow(r, s) || !s.tableLabel) continue;
    if (tableOccupancyKey(s.area, s.tableLabel) !== key) continue;
    const st = String(s.status || '').toUpperCase();
    if (st === 'CANCELLED' || st === 'NO_SHOW') continue;
    const sStart = reservationOccupancyStartMs(s);
    if (sStart == null || sStart <= start) continue;
    if (next == null || sStart < next) next = sStart;
  }
  return next;
}

function previousSittingEndMs(
  r: OccupancyReservation,
  siblings: OccupancyReservation[],
): number | null {
  const start = reservationOccupancyStartMs(r);
  if (start == null || !r.tableLabel) return null;
  const key = tableOccupancyKey(r.area, r.tableLabel);
  let prevEnd: number | null = null;
  let prevStart = -Infinity;
  for (const s of siblings) {
    if (sameReservationRow(r, s) || !s.tableLabel) continue;
    if (tableOccupancyKey(s.area, s.tableLabel) !== key) continue;
    const st = String(s.status || '').toUpperCase();
    if (st === 'CANCELLED' || st === 'NO_SHOW') continue;
    const sStart = reservationOccupancyStartMs(s);
    if (sStart == null || sStart >= start) continue;
    if (sStart < prevStart) continue;
    const sEnd =
      reservationEndMs(new Date(sStart), s.durationMin) ?? sStart + 90 * 60_000;
    prevStart = sStart;
    prevEnd = sEnd;
  }
  return prevEnd;
}

function paymentFitsReservation(
  r: OccupancyReservation,
  paidAtMs: number,
  siblings: OccupancyReservation[],
): boolean {
  const status = String(r.status || '').toUpperCase();
  if (status === 'CANCELLED' || status === 'NO_SHOW') return false;
  if (!r.tableLabel) return false;
  const start = reservationOccupancyStartMs(r);
  if (start == null) return false;
  const end =
    reservationEndMs(new Date(start), r.durationMin) ?? start + 90 * 60_000;
  let lo = start - OPEN_TICKET_BOOKING_GRACE_MS;
  const prevEnd = previousSittingEndMs(r, siblings);
  if (prevEnd != null) lo = Math.max(lo, prevEnd);
  const hiCap = end + PAID_TICKET_AFTER_GRACE_MS;
  const next = nextSittingStartMs(r, siblings);
  if (next != null) {
    return paidAtMs >= lo && paidAtMs < Math.min(hiCap, next);
  }
  return paidAtMs >= lo && paidAtMs <= hiCap;
}

/**
 * True when the waiter has paid a ticket that belongs to this reservation
 * sitting. An open ticket on the same table takes precedence.
 * Pass the day's other reservations so a late payment is not attached to
 * the next booking on the same table.
 */
export function reservationHasPaidTicket(
  r: OccupancyReservation,
  paidTables: PaidPosTable[],
  openTables: Array<{ area: string; label: string }> = [],
  siblings: OccupancyReservation[] = [],
): boolean {
  if (!r.tableLabel) return false;
  const key = tableOccupancyKey(r.area, r.tableLabel);
  if (openTables.some((t) => tableOccupancyKey(t.area, t.label) === key)) {
    return false;
  }
  return paidTables.some((p) => {
    if (tableOccupancyKey(p.area, p.label) !== key) return false;
    const at = Date.parse(p.paidAt);
    return Number.isFinite(at) && paymentFitsReservation(r, at, siblings);
  });
}

/** Paid POS tickets with no reservation sitting to attach the Paguar chip to. */
export function uncoveredPaidTables(
  paidTables: PaidPosTable[],
  reservations: OccupancyReservation[],
  openTables: Array<{ area: string; label: string }> = [],
): PaidPosTable[] {
  const seen = new Set<string>();
  const out: PaidPosTable[] = [];
  for (const p of paidTables) {
    const area = String(p.area || '').trim();
    const label = String(p.label || '').trim();
    if (!area || !label) continue;
    const key = tableOccupancyKey(area, label);
    if (seen.has(key)) continue;
    seen.add(key);
    if (openTables.some((t) => tableOccupancyKey(t.area, t.label) === key)) {
      continue;
    }
    const at = Date.parse(p.paidAt);
    if (!Number.isFinite(at)) continue;
    const attached = reservations.some((r) =>
      paymentFitsReservation(r, at, reservations),
    );
    if (attached) continue;
    out.push(p);
  }
  return out;
}
