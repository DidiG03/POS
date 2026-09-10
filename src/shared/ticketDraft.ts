import { normalizeOrderAddMode, type OrderAddMode } from './orderAddMode';

export type TicketDraftLine = {
  sku?: string;
  name: string;
  qty: number;
  unitPrice: number;
  note?: string;
  station?: string | null;
  courseId?: string | null;
  seatId?: string | null;
  staged?: boolean;
  voided?: boolean;
  paid?: boolean;
  fired?: boolean;
};

export type TicketDraft = {
  addMode: OrderAddMode;
  lines: TicketDraftLine[];
  courses: Array<{ id: string }>;
  seats: Array<{ id: string; name?: string }>;
  activeCourseId: string | null;
  activeSeatId: string | null;
  orderNote: string;
  /** When this draft was last parked or persisted. Missing or null = stale. */
  savedAt?: number | null;
};

/** Unsent cart survives leave/refresh only this long, then it is empty. */
export const TICKET_DRAFT_TTL_MS = 10_000;

export function isTicketDraftFresh(
  savedAt: number | null | undefined,
  now = Date.now(),
): boolean {
  const at = Number(savedAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  const age = now - at;
  return age >= 0 && age < TICKET_DRAFT_TTL_MS;
}

export function pruneStaleTicketDrafts(
  drafts: Record<string, TicketDraft>,
  now = Date.now(),
): Record<string, TicketDraft> {
  const next: Record<string, TicketDraft> = {};
  for (const [key, draft] of Object.entries(drafts || {})) {
    if (draft && isTicketDraftFresh(draft.savedAt, now)) next[key] = draft;
  }
  return next;
}

export function ticketDraftLineKey(
  line: Pick<
    TicketDraftLine,
    'sku' | 'name' | 'courseId' | 'seatId' | 'note' | 'unitPrice' | 'station'
  >,
): string {
  return [
    String(line.sku || line.name || '').trim(),
    String(line.courseId || ''),
    String(line.seatId || ''),
    String(line.note || ''),
    Number(line.unitPrice || 0).toFixed(4),
    String(line.station || '').toUpperCase(),
  ].join('\u0001');
}

export function snapshotTicketDraft<T extends TicketDraft>(
  s: T,
): TicketDraft & Pick<T, 'lines' | 'courses' | 'seats'> {
  return {
    addMode: normalizeOrderAddMode(s.addMode),
    lines: s.lines,
    courses: s.courses || [],
    seats: s.seats || [],
    activeCourseId: s.activeCourseId ?? null,
    activeSeatId: s.activeSeatId ?? null,
    orderNote: s.orderNote,
    savedAt: s.savedAt ?? undefined,
  };
}

export function emptyTicketDraft(
  addMode: OrderAddMode = 'default',
): TicketDraft {
  return {
    addMode: normalizeOrderAddMode(addMode),
    lines: [],
    courses: [],
    seats: [],
    activeCourseId: null,
    activeSeatId: null,
    orderNote: '',
  };
}

export function bindTicketTable<
  T extends TicketDraft & {
    boundKey: string | null;
    drafts: Record<string, TicketDraft>;
  },
>(state: T, nextKey: string | null, now = Date.now()): T {
  if (state.boundKey === nextKey) return state;
  const drafts = pruneStaleTicketDrafts({ ...state.drafts }, now);
  if (state.boundKey) {
    drafts[state.boundKey] = { ...snapshotTicketDraft(state), savedAt: now };
  }
  const loaded = nextKey ? drafts[nextKey] : null;
  if (loaded && isTicketDraftFresh(loaded.savedAt, now)) {
    const snap = snapshotTicketDraft(loaded);
    return {
      ...state,
      addMode: snap.addMode,
      lines: snap.lines as T['lines'],
      courses: snap.courses as T['courses'],
      seats: snap.seats as T['seats'],
      activeCourseId: snap.activeCourseId,
      activeSeatId: snap.activeSeatId,
      orderNote: snap.orderNote,
      savedAt: snap.savedAt ?? now,
      drafts,
      boundKey: nextKey,
    };
  }
  const empty = emptyTicketDraft();
  return {
    ...state,
    addMode: empty.addMode,
    lines: empty.lines as T['lines'],
    courses: empty.courses as T['courses'],
    seats: empty.seats as T['seats'],
    activeCourseId: empty.activeCourseId,
    activeSeatId: empty.activeSeatId,
    orderNote: empty.orderNote,
    drafts,
    boundKey: nextKey,
    savedAt: now,
  };
}

/** Drop a persisted cart that is older than the leave/refresh grace window. */
export function revivePersistedTicketDraft<
  T extends TicketDraft & {
    drafts?: Record<string, TicketDraft>;
    boundKey?: string | null;
  },
>(state: T, now = Date.now()): T {
  const drafts = pruneStaleTicketDrafts(state.drafts || {}, now);
  if (isTicketDraftFresh(state.savedAt, now)) {
    return { ...state, drafts };
  }
  const empty = emptyTicketDraft(state.addMode);
  return {
    ...state,
    addMode: empty.addMode,
    lines: empty.lines as T['lines'],
    courses: empty.courses as T['courses'],
    seats: empty.seats as T['seats'],
    activeCourseId: empty.activeCourseId,
    activeSeatId: empty.activeSeatId,
    orderNote: empty.orderNote,
    drafts,
    savedAt: now,
  };
}

/** Keep unsent local lines (and higher qty) when reloading a logged snapshot. */
export function mergeLocalStagedOntoHydrated<T extends TicketDraftLine>(
  hydrated: T[],
  local: T[],
): T[] {
  const byKey = new Map<string, T>();
  const order: string[] = [];
  for (const line of hydrated) {
    const key = ticketDraftLineKey(line);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, line);
  }
  for (const line of local) {
    if (line.voided === true || line.staged !== true) continue;
    const key = ticketDraftLineKey(line);
    const existing = byKey.get(key);
    if (!existing) {
      order.push(key);
      byKey.set(key, line);
      continue;
    }
    if (Number(line.qty) > Number(existing.qty)) {
      byKey.set(key, { ...existing, ...line, staged: true });
    }
  }
  return order.map((key) => byKey.get(key)!).filter(Boolean);
}

export function shouldKeepLocalDraftOnEmptyLog(
  localLines: TicketDraftLine[],
): boolean {
  return localLines.some((l) => l.voided !== true);
}

export function shouldMergeLocalStagedOntoHydrated(
  hydrated: TicketDraftLine[],
): boolean {
  if (!Array.isArray(hydrated) || hydrated.length === 0) return true;
  return hydrated.some((l) => l.voided !== true);
}

/**
 * A line that is already on the bill can only leave it by being voided or
 * paid, and both of those go through their own channel. So anything the
 * host still holds as fired-and-live must survive the next Send even if the
 * local cart lost it — otherwise one tap rewrites the bill from a stale
 * (or empty) cart and the guests are undercharged.
 */
export function restoreMissingServerLines<T extends TicketDraftLine>(
  outgoing: T[],
  server: T[],
): T[] {
  const present = new Set(outgoing.map((l) => ticketDraftLineKey(l)));
  const missing: T[] = [];
  for (const line of server) {
    if (line.voided === true || line.paid === true) continue;
    if (line.fired !== true) continue;
    const key = ticketDraftLineKey(line);
    if (present.has(key)) continue;
    present.add(key);
    missing.push(line);
  }
  return missing.length ? [...missing, ...outgoing] : outgoing;
}

export function applyLocalPaidOntoHydrated<T extends TicketDraftLine>(
  hydrated: T[],
  local: T[],
): T[] {
  const paid = new Set(
    local.filter((l) => l.paid === true).map((l) => ticketDraftLineKey(l)),
  );
  return hydrated.map((line) =>
    line.paid === true || paid.has(ticketDraftLineKey(line))
      ? { ...line, paid: true }
      : line,
  );
}
