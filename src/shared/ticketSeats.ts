export type TicketSeat = { id: string; name?: string };

export function newTicketSeatId(): string {
  return `seat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeSeatName(raw: unknown): string | undefined {
  const n = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return undefined;
  return n.slice(0, 24);
}

export function seatLabel(
  seats: TicketSeat[],
  seatId: string | null | undefined,
  fallback: string,
): string {
  const id = String(seatId || '').trim();
  const seat = seats.find((s) => s.id === id);
  return normalizeSeatName(seat?.name) || fallback;
}

export function seatsFromLineIds<T extends { seatId?: string | null }>(
  lines: T[],
  existing?: TicketSeat[],
): TicketSeat[] {
  const seen = new Set<string>();
  const out: TicketSeat[] = [];
  for (const s of existing || []) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    const name = normalizeSeatName(s.name);
    out.push(name ? { id: s.id, name } : { id: s.id });
  }
  for (const line of lines) {
    const id = String(line.seatId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id });
  }
  return out;
}

export function groupLinesBySeat<T extends { seatId?: string | null }>(
  seats: TicketSeat[],
  lines: T[],
): Array<{ seat: TicketSeat; lines: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const s of seats) buckets.set(s.id, []);
  const ungrouped: T[] = [];
  for (const line of lines) {
    const id = String(line.seatId || '').trim();
    const bucket = id ? buckets.get(id) : undefined;
    if (bucket) bucket.push(line);
    else ungrouped.push(line);
  }
  const groups = seats.map((seat) => ({
    seat,
    lines: buckets.get(seat.id) || [],
  }));
  if (ungrouped.length) {
    if (groups[0]) {
      groups[0] = { ...groups[0], lines: [...ungrouped, ...groups[0].lines] };
    } else {
      groups.push({ seat: { id: newTicketSeatId() }, lines: ungrouped });
    }
  }
  return groups;
}

export function flattenSeatGroups<T>(
  groups: Array<{ seat: TicketSeat; lines: T[] }>,
): T[] {
  return groups.flatMap((g) =>
    g.lines.map((line) => ({ ...line, seatId: g.seat.id })),
  );
}

export function moveLineToSeat<
  T extends { id: string; seatId?: string | null },
>(
  seats: TicketSeat[],
  lines: T[],
  lineId: string,
  toSeatId: string,
  toIndex: number,
): T[] {
  const groups = groupLinesBySeat(seats, lines);
  let moved: T | undefined;
  for (const g of groups) {
    const idx = g.lines.findIndex((l) => l.id === lineId);
    if (idx < 0) continue;
    moved = g.lines[idx];
    g.lines = g.lines.filter((l) => l.id !== lineId);
    break;
  }
  if (!moved) return lines;
  const dest = groups.find((g) => g.seat.id === toSeatId);
  if (!dest) {
    return flattenSeatGroups(groups).concat({
      ...moved,
      seatId: toSeatId,
    });
  }
  const insertAt = Math.max(
    0,
    Math.min(Math.floor(toIndex), dest.lines.length),
  );
  dest.lines = [
    ...dest.lines.slice(0, insertAt),
    { ...moved, seatId: toSeatId },
    ...dest.lines.slice(insertAt),
  ];
  return flattenSeatGroups(groups);
}

export function seatNumber(
  seats: Array<{ id: string }>,
  seatId?: string | null,
): number | null {
  const id = String(seatId || '').trim();
  if (!id) return null;
  const i = seats.findIndex((s) => s.id === id);
  return i >= 0 ? i + 1 : null;
}

export function isBillableLine<T extends { voided?: boolean; paid?: boolean }>(
  line: T,
): boolean {
  return line.voided !== true && line.paid !== true;
}

/** Prefer the waiter's selected seat; never fall back to “no seat”. */
export function seatIdForNewLine(input: {
  explicit?: string | null;
  activeSeatId?: string | null;
  seats: Array<{ id: string }>;
}): string | null {
  const explicit = String(input.explicit || '').trim();
  if (explicit) return explicit;
  const active = String(input.activeSeatId || '').trim();
  if (active) return active;
  return input.seats[0]?.id || null;
}

export function unpaidLinesForSeat<
  T extends { seatId?: string | null; voided?: boolean; paid?: boolean },
>(lines: T[], seatId: string): T[] {
  const id = String(seatId || '').trim();
  if (!id) return [];
  return lines.filter(
    (l) => isBillableLine(l) && String(l.seatId || '').trim() === id,
  );
}

export function unpaidSeatIds<T extends { id: string }>(
  seats: T[],
  lines: Array<{ seatId?: string | null; voided?: boolean; paid?: boolean }>,
): string[] {
  return seats
    .filter((s) => unpaidLinesForSeat(lines, s.id).length > 0)
    .map((s) => s.id);
}

/** Table closes only when this payment covers every remaining unpaid line. */
export function shouldCloseTableAfterSeatPay<
  T extends { id: string; voided?: boolean; paid?: boolean },
>(lines: T[], payingLineIds: string[]): boolean {
  const paying = new Set(payingLineIds);
  return !lines.some((l) => isBillableLine(l) && !paying.has(l.id));
}
