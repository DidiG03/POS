import { prisma } from '@db/client';
import type {
  ReservationCreateInput,
  ReservationDTO,
  ReservationStatus,
  ReservationUpdateInput,
} from '@shared/ipc';
import {
  occupancyOverlapsInstant,
  reservationCoversOpenTicket,
  reservationKeepsTableAssignment,
} from '@shared/tableOccupancy';
import { broadcastReservationsChanged } from './realtime';
import { coreServices } from './core';
import {
  DEFAULT_RESERVATION_DURATION_MIN,
  reservationOccupiesTable,
} from '@shared/reservationDuration';

// All reservation business logic lives here so the Electron IPC layer
// (src/main/index.ts) and the LAN HTTP layer (src/main/api.ts) share the
// exact same authorization, validation, conflict-detection, and DTO mapping.
// Without this, mobile clients (Capacitor + Vite mobile build) hitting the
// HTTP API would diverge from the desktop renderer's IPC behaviour.

// Hydrate the `createdByName` field on a single row so individual mutations
// return the same shape as `listReservationsForDay`. Falls back to `null`
// if the user can't be loaded (deleted user, DB error, …) so the caller
// is never blocked from seeing the row it just wrote.
async function withCreatedByName(row: any): Promise<ReservationDTO> {
  const id = Number(row?.createdById || 0);
  if (!id) return mapReservation(row);
  try {
    const u = await prisma.user.findUnique({
      where: { id },
      select: { id: true, displayName: true },
    });
    if (!u) return mapReservation(row);
    const map = new Map<number, string>([
      [Number((u as any).id), String((u as any).displayName || '')],
    ]);
    return mapReservation(row, map);
  } catch {
    return mapReservation(row);
  }
}

const ALLOWED_STATUSES = [
  'BOOKED',
  'SEATED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export function dayBounds(iso: string): { start: Date; end: Date } {
  const d = new Date(iso);
  const start = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    0,
    0,
    0,
    0,
  );
  const end = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999,
  );
  return { start, end };
}

export async function assertHostOrAdmin(userId: number): Promise<void> {
  if (!userId) {
    throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  }
  const u = await prisma.user.findFirst({
    where: { id: userId, active: true } as any,
  });
  const role = String((u as any)?.role || '').toUpperCase();
  if (!u || (role !== 'HOST' && role !== 'ADMIN')) {
    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
  }
}

// Reject creates/updates that would put two live reservations on the same
// (area, tableLabel) at overlapping times. CANCELLED / NO_SHOW / COMPLETED
// reservations free the table and are ignored, matching the floor view colour
// logic. Reservations without a tableLabel are pure waitlist entries and are
// allowed to coexist (they're shown in the "Unassigned" panel).
export async function assertNoTableConflict(args: {
  id?: number;
  area: string;
  tableLabel: string | null;
  startsAt: Date;
  durationMin: number;
  /**
   * Skip the open-ticket guard when this reservation already holds the
   * table (host seated them; waiter then opened the ticket — same sitting).
   */
  skipOpenTicket?: boolean;
}): Promise<void> {
  const tableLabel = (args.tableLabel || '').trim();
  if (!tableLabel) return;
  const area = args.area.trim();
  if (!area) return;
  // An unpaid ticket blocks a walk-in / overlapping slot, not a later
  // booking tonight (e.g. T8 at 22:00 while lunch is still open).
  const ticketBlocksSlot =
    !args.skipOpenTicket &&
    occupancyOverlapsInstant(args.startsAt, args.durationMin, Date.now());
  if (ticketBlocksSlot) {
    const open = await coreServices.isTableOpen(area, tableLabel);
    if (open) {
      throw Object.assign(
        new Error(
          `Table ${tableLabel} has an open ticket. Pay or transfer it before reserving.`,
        ),
        { statusCode: 409, code: 'TABLE_OPEN_TICKET' },
      );
    }
  }
  const startMs = args.startsAt.getTime();
  if (!Number.isFinite(startMs)) return;
  const durMs =
    Math.max(15, Math.min(720, Number(args.durationMin) || 0)) * 60_000;
  const endMs = startMs + durMs;
  // Pad the scan window by 12h on each side because durations are capped at
  // 12h, so any overlapping reservation must start within that range.
  const lower = new Date(startMs - 12 * 60 * 60 * 1000);
  const upper = new Date(endMs + 12 * 60 * 60 * 1000);
  const candidates = await prisma.reservation.findMany({
    where: {
      area,
      tableLabel,
      status: { notIn: ['CANCELLED', 'NO_SHOW', 'COMPLETED'] as any },
      startsAt: { gte: lower, lte: upper },
      ...(args.id ? { NOT: { id: args.id } } : {}),
    },
    select: {
      id: true,
      startsAt: true,
      durationMin: true,
      customerName: true,
    },
    take: 50,
  });
  for (const c of candidates as any[]) {
    const cStart = new Date(c.startsAt).getTime();
    const cEnd = cStart + (Number(c.durationMin) || 0) * 60_000;
    // Half-open intervals: touching back-to-back (end == start) is allowed.
    if (cStart < endMs && cEnd > startMs) {
      const t = new Date(cStart);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const who = String(c.customerName || '').trim() || 'another guest';
      throw Object.assign(
        new Error(
          `Table ${tableLabel} already has a reservation at ${hh}:${mm} for ${who}.`,
        ),
        { statusCode: 409, code: 'RESERVATION_CONFLICT' },
      );
    }
  }
}

export function mapReservation(
  r: any,
  userMap?: Map<number, string>,
): ReservationDTO {
  return {
    id: Number(r.id),
    area: String(r.area || ''),
    tableLabel: r.tableLabel ?? null,
    customerName: String(r.customerName || ''),
    customerPhone: r.customerPhone ?? null,
    partySize: Number(r.partySize || 0),
    startsAt: new Date(r.startsAt).toISOString(),
    seatedAt: r.seatedAt ? new Date(r.seatedAt).toISOString() : null,
    durationMin: Number(r.durationMin || 0),
    note: r.note ?? null,
    status: String(r.status || 'BOOKED') as any,
    createdById: Number(r.createdById),
    createdByName: (userMap && userMap.get(Number(r.createdById))) ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listReservationsForDay(input: {
  dateIso: string;
  area?: string;
}): Promise<ReservationDTO[]> {
  const dateIso = String(input?.dateIso || '');
  if (!dateIso) return [];
  const { start, end } = dayBounds(dateIso);
  const where: any = { startsAt: { gte: start, lte: end } };
  if (input?.area) where.area = String(input.area);
  const rows = await prisma.reservation.findMany({
    where,
    orderBy: { startsAt: 'asc' },
    take: 1000,
  });
  const ids = Array.from(
    new Set((rows as any[]).map((r) => Number(r.createdById))),
  );
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true },
      })
    : [];
  const userMap = new Map<number, string>(
    (users as any[]).map((u) => [Number(u.id), String(u.displayName || '')]),
  );
  return (rows as any[]).map((r) => mapReservation(r, userMap));
}

export async function listReservationCounts(input: {
  startIso: string;
  endIso: string;
}): Promise<Record<string, number>> {
  const start = new Date(String(input?.startIso || ''));
  const end = new Date(String(input?.endIso || ''));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return {};
  }
  // Hard-cap to ~13 months so a misconfigured client can't scan the entire
  // table in one go.
  const maxSpan = 400 * 24 * 60 * 60 * 1000;
  const cappedEnd = new Date(
    Math.min(end.getTime(), start.getTime() + maxSpan),
  );
  const rows = await prisma.reservation.findMany({
    where: {
      startsAt: { gte: start, lte: cappedEnd },
      status: { notIn: ['CANCELLED', 'NO_SHOW'] as any },
    },
    select: { startsAt: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows as any[]) {
    const d = new Date(r.startsAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export async function createReservation(
  input: ReservationCreateInput,
): Promise<ReservationDTO> {
  const createdById = Number(input?.createdById || 0);
  await assertHostOrAdmin(createdById);
  const customerName = String(input?.customerName || '').trim();
  if (!customerName) throw new Error('customerName required');
  const area = String(input?.area || '').trim();
  if (!area) throw new Error('area required');
  const startsAt = new Date(String(input?.startsAtIso || ''));
  if (!Number.isFinite(startsAt.getTime())) throw new Error('invalid startsAt');
  const partySize = clampInt(input?.partySize, 1, 200, 2);
  const durationMin = clampInt(
    input?.durationMin,
    15,
    720,
    DEFAULT_RESERVATION_DURATION_MIN,
  );
  const tableLabel = input?.tableLabel ? String(input.tableLabel) : null;
  // Validate explicitly so a malformed renderer payload can't sneak invalid
  // enum values past Prisma at runtime.
  const requested = String(input?.status || '').toUpperCase();
  const status: ReservationStatus = (
    ALLOWED_STATUSES as readonly string[]
  ).includes(requested)
    ? (requested as ReservationStatus)
    : ('BOOKED' as ReservationStatus);
  await assertNoTableConflict({ area, tableLabel, startsAt, durationMin });
  const created = await prisma.reservation.create({
    data: {
      area,
      tableLabel,
      customerName,
      customerPhone: input?.customerPhone ? String(input.customerPhone) : null,
      partySize,
      startsAt,
      seatedAt: status === 'SEATED' ? startsAt : null,
      durationMin,
      note: input?.note ? String(input.note) : null,
      createdById,
      status: status as any,
    } as any,
  });
  const dto = await withCreatedByName(created);
  broadcastReservationsChanged({
    kind: 'created',
    id: dto.id,
    dateIso: dto.startsAt,
    area: dto.area,
    status: dto.status,
  });
  return dto;
}

export async function updateReservation(
  input: ReservationUpdateInput,
): Promise<ReservationDTO> {
  const id = Number(input?.id || 0);
  if (!id) throw new Error('id required');
  const existing = await prisma.reservation.findUnique({ where: { id } });
  if (!existing)
    throw Object.assign(new Error('not found'), { statusCode: 404 });
  // The renderer always supplies the active session id, but defaulting to the
  // row owner keeps this safe even if the caller omits it.
  await assertHostOrAdmin(
    Number(input?.actorId || (existing as any).createdById || 0),
  );
  const data: any = {};
  if (typeof input?.area === 'string') data.area = input.area.trim();
  if (typeof input?.tableLabel !== 'undefined')
    data.tableLabel = input.tableLabel ? String(input.tableLabel) : null;
  if (typeof input?.customerName === 'string')
    data.customerName = input.customerName.trim();
  if (typeof input?.customerPhone !== 'undefined')
    data.customerPhone = input.customerPhone
      ? String(input.customerPhone)
      : null;
  if (typeof input?.partySize !== 'undefined')
    data.partySize = clampInt(input.partySize, 1, 200, 2);
  if (typeof input?.startsAtIso === 'string') {
    const d = new Date(input.startsAtIso);
    if (Number.isFinite(d.getTime())) data.startsAt = d;
  }
  if (typeof input?.durationMin !== 'undefined')
    data.durationMin = clampInt(
      input.durationMin,
      15,
      720,
      DEFAULT_RESERVATION_DURATION_MIN,
    );
  if (typeof input?.note !== 'undefined')
    data.note = input.note ? String(input.note) : null;
  // Merge incoming changes onto the existing row to detect double-booking
  // even when the renderer only sends a partial update.
  const mergedArea = String(data.area ?? (existing as any).area ?? '');
  const mergedTable =
    'tableLabel' in data
      ? (data.tableLabel as string | null)
      : ((existing as any).tableLabel ?? null);
  const mergedStart =
    (data.startsAt as Date | undefined) ?? (existing as any).startsAt;
  const mergedDuration = Number(
    data.durationMin ?? (existing as any).durationMin ?? 0,
  );
  await assertNoTableConflict({
    id,
    area: mergedArea,
    tableLabel: mergedTable,
    startsAt: new Date(mergedStart),
    durationMin: mergedDuration,
    skipOpenTicket: reservationKeepsTableAssignment(
      {
        area: String((existing as any).area || ''),
        tableLabel: ((existing as any).tableLabel as string | null) ?? null,
      },
      { area: mergedArea, tableLabel: mergedTable },
    ),
  });
  const updated = await prisma.reservation.update({
    where: { id },
    data,
  });
  const dto = await withCreatedByName(updated);
  broadcastReservationsChanged({
    kind: 'updated',
    id: dto.id,
    dateIso: dto.startsAt,
    area: dto.area,
    status: dto.status,
  });
  return dto;
}

export async function setReservationStatus(input: {
  id: number;
  actorId: number;
  status: string;
}): Promise<ReservationDTO> {
  const id = Number(input?.id || 0);
  if (!id) throw new Error('id required');
  const status = String(input?.status || '').toUpperCase();
  if (!(ALLOWED_STATUSES as readonly string[]).includes(status))
    throw new Error('invalid status');
  await assertHostOrAdmin(Number(input?.actorId || 0));
  const existing = await prisma.reservation.findUnique({ where: { id } });
  if (!existing)
    throw Object.assign(new Error('not found'), { statusCode: 404 });
  const data: { status: any; seatedAt?: Date | null } = {
    status: status as any,
  };
  if (status === 'SEATED' && String((existing as any).status) !== 'SEATED') {
    data.seatedAt = new Date();
  }
  if (status === 'BOOKED') {
    data.seatedAt = null;
  }
  const updated = await prisma.reservation.update({
    where: { id },
    data,
  });
  const dto = await withCreatedByName(updated);
  broadcastReservationsChanged({
    kind: 'status',
    id: dto.id,
    dateIso: dto.startsAt,
    area: dto.area,
    status: dto.status,
  });
  return dto;
}

export async function deleteReservation(input: {
  id: number;
  actorId: number;
}): Promise<boolean> {
  const id = Number(input?.id || 0);
  if (!id) return false;
  await assertHostOrAdmin(Number(input?.actorId || 0));
  // Read the row first so we can include `dateIso`/`area` in the broadcast,
  // letting clients on a different day cheaply ignore the event.
  const existing = await prisma.reservation
    .findUnique({ where: { id }, select: { startsAt: true, area: true } })
    .catch(() => null as any);
  await prisma.reservation.delete({ where: { id } }).catch(() => null);
  broadcastReservationsChanged({
    kind: 'deleted',
    id,
    dateIso: existing?.startsAt
      ? new Date(existing.startsAt).toISOString()
      : undefined,
    area: existing?.area ?? null,
  });
  return true;
}

/**
 * When a waiter opens a ticket, seat the BOOKED reservation that already
 * covers this table so the host row does not stay BOOKED with a ticket chip.
 * No host/admin check — this is an internal side effect of POS table open.
 */
export async function seatCoveringReservationForOpenTable(
  area: string,
  tableLabel: string,
): Promise<void> {
  try {
    const a = String(area || '').trim();
    const label = String(tableLabel || '').trim();
    if (!a || !label) return;
    const now = Date.now();
    const { start, end } = dayBounds(new Date().toISOString());
    const rows = await prisma.reservation.findMany({
      where: {
        area: a,
        tableLabel: label,
        status: 'BOOKED',
        startsAt: { gte: start, lte: end },
      },
      take: 20,
    });
    const match = (rows as any[])
      .map((r) => mapReservation(r))
      .filter((r) => reservationCoversOpenTicket(r, now))
      .sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt))[0];
    if (!match) return;
    const updated = await prisma.reservation.update({
      where: { id: match.id },
      data: { status: 'SEATED', seatedAt: new Date() },
    });
    const dto = await withCreatedByName(updated);
    broadcastReservationsChanged({
      kind: 'status',
      id: dto.id,
      dateIso: dto.startsAt,
      area: dto.area,
      status: dto.status,
    });
  } catch {
    // never block opening a table
  }
}

/**
 * Follow a covering live reservation when the waiter moves the ticket.
 * Skip if the destination already has an occupying sitting.
 */
export async function moveCoveringReservationForTableTransfer(
  fromArea: string,
  fromLabel: string,
  toArea: string,
  toLabel: string,
): Promise<void> {
  try {
    const fa = String(fromArea || '').trim();
    const fl = String(fromLabel || '').trim();
    const ta = String(toArea || '').trim();
    const tl = String(toLabel || '').trim();
    if (!fa || !fl || !ta || !tl) return;
    if (fa === ta && fl === tl) return;
    const now = Date.now();
    const { start, end } = dayBounds(new Date().toISOString());
    const fromRows = await prisma.reservation.findMany({
      where: {
        area: fa,
        tableLabel: fl,
        status: { in: ['BOOKED', 'SEATED'] as any },
        startsAt: { gte: start, lte: end },
      },
    });
    const covering = (fromRows as any[])
      .map((r) => mapReservation(r))
      .filter(
        (r) =>
          reservationCoversOpenTicket(r, now) ||
          (r.status === 'SEATED' && reservationOccupiesTable(r, now)),
      )
      .sort((a, b) => {
        const seated =
          (a.status === 'SEATED' ? 0 : 1) - (b.status === 'SEATED' ? 0 : 1);
        if (seated !== 0) return seated;
        return Date.parse(a.startsAt) - Date.parse(b.startsAt);
      })[0];
    if (!covering) return;

    const destRows = await prisma.reservation.findMany({
      where: {
        area: ta,
        tableLabel: tl,
        status: { in: ['BOOKED', 'SEATED'] as any },
        startsAt: { gte: start, lte: end },
      },
    });
    const destBusy = (destRows as any[]).some((row) =>
      reservationOccupiesTable(mapReservation(row), now),
    );
    if (destBusy) return;

    const updated = await prisma.reservation.update({
      where: { id: covering.id },
      data: { area: ta, tableLabel: tl },
    });
    const dto = await withCreatedByName(updated);
    broadcastReservationsChanged({
      kind: 'updated',
      id: dto.id,
      dateIso: dto.startsAt,
      area: dto.area,
    });
  } catch {
    // never block the ticket transfer
  }
}
