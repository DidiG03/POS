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

/** Sent lines are the live bill — they must not expire with the unsent-draft timer. */
export function draftHasLiveBill(
  draft: { lines?: TicketDraftLine[] } | null | undefined,
): boolean {
  return (draft?.lines || []).some(
    (l) => l.voided !== true && l.staged !== true,
  );
}

export function shouldKeepTicketDraft(
  draft:
    | { lines?: TicketDraftLine[]; savedAt?: number | null }
    | null
    | undefined,
  now = Date.now(),
  opts?: { keepLiveBill?: boolean },
): boolean {
  if (!draft) return false;
  if (draftHasLiveBill(draft)) return opts?.keepLiveBill !== false;
  return isTicketDraftFresh(draft.savedAt, now);
}

export function pruneStaleTicketDrafts(
  drafts: Record<string, TicketDraft>,
  now = Date.now(),
): Record<string, TicketDraft> {
  const next: Record<string, TicketDraft> = {};
  for (const [key, draft] of Object.entries(drafts || {})) {
    if (draft && shouldKeepTicketDraft(draft, now)) next[key] = draft;
  }
  return next;
}

/**
 * Sent bills belong to an occupied sitting. Once the host says the table
 * is free, restoring that draft paints items on a green table.
 * Unsent carts still survive the short leave/refresh window.
 */
export function pruneLiveBillsForClosedTables(
  drafts: Record<string, TicketDraft>,
  openKeys: Iterable<string>,
  now = Date.now(),
): Record<string, TicketDraft> {
  const open = new Set(
    [...openKeys].map((k) => String(k || '').trim()).filter(Boolean),
  );
  const next: Record<string, TicketDraft> = {};
  for (const [key, draft] of Object.entries(drafts || {})) {
    if (!draft) continue;
    const keepLiveBill = open.has(key);
    if (shouldKeepTicketDraft(draft, now, { keepLiveBill })) next[key] = draft;
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
>(
  state: T,
  nextKey: string | null,
  now = Date.now(),
  opts?: { keepLiveBill?: boolean },
): T {
  if (state.boundKey === nextKey) {
    if (nextKey && opts?.keepLiveBill === false && draftHasLiveBill(state)) {
      const drafts = { ...state.drafts };
      delete drafts[nextKey];
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
    return state;
  }
  const drafts = pruneStaleTicketDrafts({ ...state.drafts }, now);
  if (state.boundKey) {
    drafts[state.boundKey] = { ...snapshotTicketDraft(state), savedAt: now };
  }
  const loaded = nextKey ? drafts[nextKey] : null;
  const keepLiveBill = nextKey ? opts?.keepLiveBill !== false : false;
  if (nextKey && !keepLiveBill && loaded && draftHasLiveBill(loaded)) {
    delete drafts[nextKey];
  }
  if (loaded && shouldKeepTicketDraft(loaded, now, { keepLiveBill })) {
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

/** Drop a persisted unsent cart that is older than the leave/refresh grace window. */
export function revivePersistedTicketDraft<
  T extends TicketDraft & {
    drafts?: Record<string, TicketDraft>;
    boundKey?: string | null;
  },
>(state: T, now = Date.now()): T {
  const drafts = pruneStaleTicketDrafts(state.drafts || {}, now);
  if (shouldKeepTicketDraft(state, now)) {
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

/**
 * Keep unsent local lines (and higher qty) when reloading a logged snapshot.
 *
 * The snapshot is the bill, so every one of its lines is kept as-is. Two rows
 * can legitimately share a line key — 3x Water sent, then 1x Water sent after
 * it — and folding them together by key would drop the earlier quantity off
 * the ticket.
 *
 * A local unsent line is only the same line as a hydrated line that is itself
 * still unsent. Ordering one more of something already sent is a new line, not
 * a higher quantity of the sent one, so it is appended instead of compared.
 */
export function mergeLocalStagedOntoHydrated<T extends TicketDraftLine>(
  hydrated: T[],
  local: T[],
): T[] {
  const out: T[] = [...hydrated];
  const stagedAt = new Map<string, number>();
  out.forEach((line, i) => {
    if (line.voided === true || line.staged !== true) return;
    const key = ticketDraftLineKey(line);
    if (!stagedAt.has(key)) stagedAt.set(key, i);
  });
  for (const line of local) {
    if (line.voided === true || line.staged !== true) continue;
    const key = ticketDraftLineKey(line);
    const at = stagedAt.get(key);
    if (at == null) {
      stagedAt.set(key, out.length);
      out.push(line);
      continue;
    }
    if (Number(line.qty) > Number(out[at].qty)) {
      out[at] = { ...out[at], ...line, staged: true };
    }
  }
  return out;
}

export function shouldKeepLocalDraftOnEmptyLog(
  localLines: Array<{ voided?: boolean }>,
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
 *
 * `onBill` is the part of `outgoing` that was already fired before this Send;
 * it defaults to all of `outgoing`. Lines being fired right now must be left
 * out of it, because matching on the line key alone cannot tell "the host's
 * 3x Water is already in this payload" from "this payload adds 1x more Water",
 * and treating the second as the first bills one water instead of four.
 */
export function restoreMissingServerLines<T extends TicketDraftLine>(
  outgoing: T[],
  server: T[],
  onBill: T[] = outgoing,
): T[] {
  const have = new Map<string, number>();
  for (const line of onBill) {
    const key = ticketDraftLineKey(line);
    have.set(key, (have.get(key) || 0) + Number(line.qty || 0));
  }
  const wanted = new Map<string, { line: T; qty: number }>();
  const order: string[] = [];
  for (const line of server) {
    if (line.voided === true || line.paid === true) continue;
    if (line.fired !== true) continue;
    const key = ticketDraftLineKey(line);
    const seen = wanted.get(key);
    if (seen) {
      seen.qty += Number(line.qty || 0);
      continue;
    }
    wanted.set(key, { line, qty: Number(line.qty || 0) });
    order.push(key);
  }
  const missing: T[] = [];
  for (const key of order) {
    const entry = wanted.get(key)!;
    const gap = entry.qty - (have.get(key) || 0);
    if (gap > 0) missing.push({ ...entry.line, qty: gap });
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
