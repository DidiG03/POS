import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useSessionStore } from './session';
import { ticketLineId } from '@shared/utils/ticketLineId';
import { isImmediateFireStation } from '@shared/ticketCourseFire';
import {
  inferOrderAddMode,
  normalizeOrderAddMode,
  type OrderAddMode,
} from '@shared/orderAddMode';
import {
  bindTicketTable,
  draftHasLiveBill,
  emptyTicketDraft,
  carryPendingOntoHydrated,
  mergeLocalStagedOntoHydrated,
  moveTicketDraft,
  pendingLinesOnly,
  pruneStaleTicketDrafts,
  pruneLiveBillsForClosedTables,
  revivePersistedTicketDraft,
  applyLocalPaidOntoHydrated,
  shouldKeepLocalDraftOnEmptyLog,
  shouldMergeLocalStagedOntoHydrated,
  snapshotTicketDraft,
  switchTicketDraftUser,
  type TicketDraft,
  NATIVE_TICKET_DRAFT_TTL_MS,
  setTicketDraftTtlMs,
} from '@shared/ticketDraft';
import {
  coursesFromLineIds,
  flattenCourseGroups,
  groupLinesByCourse,
  moveLineToCourse as relocateTicketLine,
  newTicketCourseId,
  reorderList,
  courseIdForNewLine,
  type TicketCourse,
} from '@shared/ticketCourses';
import {
  flattenSeatGroups,
  groupLinesBySeat,
  moveLineToSeat as relocateTicketSeatLine,
  newTicketSeatId,
  normalizeSeatName,
  seatsFromLineIds,
  seatIdForNewLine,
  type TicketSeat,
} from '@shared/ticketSeats';

export interface TicketLine {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  vatRate: number; // 0.2 = 20%
  qty: number;
  note?: string;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  categoryId?: number;
  categoryName?: string;
  courseId?: string | null;
  seatId?: string | null;
  // When true, this line was added locally in the current session (not from last logged ticket)
  staged?: boolean;
  voided?: boolean;
  paid?: boolean;
  /**
   * Idempotency key of the Send that fired this line. Lets the till tell a
   * Send it already has (carried by a later one) from a new one.
   */
  sendKey?: string;
  /** Its Send is waiting in the offline queue (see `ticketDraft.ts`). */
  pending?: boolean;
}

export type TicketLogItem = {
  name: string;
  qty: number;
  unitPrice: number;
  vatRate?: number;
  note?: string;
  voided?: boolean;
  sku?: string;
  courseId?: string | null;
  seatId?: string | null;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  categoryId?: number;
  categoryName?: string;
  /** False = held for a later course fire. Missing = already sent (legacy). */
  fired?: boolean;
  paid?: boolean;
  /** See {@link TicketLine.sendKey}. */
  sendKey?: string;
  /**
   * The bill line's id, set by the till (`ticketLineIds.ts`). A hydrated
   * line keeps it as its `id`; a void names the line by it.
   */
  lineId?: string;
};

export function toTicketLogLine(
  l: TicketLine,
  extra?: { fired?: boolean },
): TicketLogItem {
  return {
    sku: l.sku,
    name: l.name,
    qty: l.qty,
    unitPrice: l.unitPrice,
    vatRate: l.vatRate,
    note: l.note,
    voided: l.voided,
    station: l.station,
    categoryId: l.categoryId,
    categoryName: l.categoryName,
    courseId: isImmediateFireStation(l.station) ? null : l.courseId || null,
    seatId: l.seatId || null,
    fired: extra?.fired,
    paid: l.paid === true,
    ...(l.sendKey ? { sendKey: l.sendKey } : {}),
    lineId: l.id,
  };
}

interface TicketState {
  lines: TicketLine[];
  courses: TicketCourse[];
  seats: TicketSeat[];
  activeCourseId: string | null;
  activeSeatId: string | null;
  orderNote: string;
  addMode: OrderAddMode;
  boundKey: string | null;
  drafts: Record<string, TicketDraft>;
  /** The waiter `drafts` and the cart on screen belong to. */
  draftUserId: number | null;
  /** Other waiters' carts on this device, by user id (`switchTicketDraftUser`). */
  userDrafts: Record<string, Record<string, TicketDraft>>;
  savedAt: number | null;
  hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
  setAddMode: (mode: OrderAddMode) => void;
  bindTable: (key: string | null, opts?: { keepLiveBill?: boolean }) => void;
  /** A waiter signed in: their own carts, never the last waiter's. */
  bindUser: (userId: number | null | undefined) => void;
  /** After a table transfer: bind `toKey` with the source's pre-move draft. */
  moveDraft: (fromKey: string, toKey: string, draft: TicketDraft) => void;
  dropOrphanLiveBills: (openKeys: string[]) => void;
  addItem: (input: {
    sku: string;
    name: string;
    unitPrice: number;
    vatRate?: number;
    qty?: number;
    station?: 'KITCHEN' | 'BAR' | 'DESSERT';
    categoryId?: number;
    categoryName?: string;
    courseId?: string | null;
    seatId?: string | null;
  }) => void;
  increment: (id: string) => void;
  decrement: (id: string) => void;
  removeLine: (id: string) => void;
  markLineVoided: (id: string) => void;
  markLinesAsPaid: (ids: string[]) => void;
  setLineNote: (id: string, note: string) => void;
  setOrderNote: (note: string) => void;
  hydrate: (payload: { items: TicketLogItem[]; note?: string | null }) => void;
  clear: () => void;
  markAllAsSent: () => void;
  /** Unstage after a Send; `sendKey` is that Send's idempotency key. */
  markLinesAsSent: (ids: string[], sendKey?: string) => void;
  /** Undo {@link markLinesAsSent} when a Send fails after optimistic unstage. */
  markLinesAsStaged: (ids: string[]) => void;
  /** The Send of these lines was queued offline: show them as pending. */
  markLinesPending: (ids: string[]) => void;
  ensureCourses: () => void;
  addCourse: () => void;
  removeCourse: (courseId: string) => void;
  setActiveCourseId: (courseId: string | null) => void;
  reorderCourses: (fromIndex: number, toIndex: number) => void;
  moveLineToCourse: (
    lineId: string,
    toCourseId: string,
    toIndex: number,
  ) => void;
  ensureSeats: () => void;
  addSeat: () => void;
  removeSeat: (seatId: string) => void;
  setActiveSeatId: (seatId: string | null) => void;
  reorderSeats: (fromIndex: number, toIndex: number) => void;
  renameSeat: (seatId: string, name: string) => void;
  moveLineToSeat: (lineId: string, toSeatId: string, toIndex: number) => void;
}

function emptyCourses(): Pick<TicketState, 'courses' | 'activeCourseId'> {
  return { courses: [], activeCourseId: null };
}

function emptySeats(): Pick<TicketState, 'seats' | 'activeSeatId'> {
  return { seats: [], activeSeatId: null };
}

function appliedCourseLayout(
  s: Pick<TicketState, 'courses' | 'lines' | 'activeCourseId'>,
): Pick<
  TicketState,
  'courses' | 'lines' | 'activeCourseId' | 'activeSeatId' | 'seats'
> {
  let courses = s.courses.length ? s.courses : coursesFromLineIds(s.lines);
  if (courses.length === 0) courses = [{ id: newTicketCourseId() }];
  const firstId = courses[0].id;
  const drinks = s.lines.filter((l) => isImmediateFireStation(l.station));
  const food = s.lines.filter((l) => !isImmediateFireStation(l.station));
  const tagged = food.map((l) =>
    l.courseId ? l : { ...l, courseId: firstId, seatId: null },
  );
  const lines = [
    ...drinks.map((l) => ({ ...l, courseId: null })),
    ...flattenCourseGroups(groupLinesByCourse(courses, tagged)),
  ];
  const active =
    s.activeCourseId && courses.some((c) => c.id === s.activeCourseId)
      ? s.activeCourseId
      : firstId;
  return {
    courses,
    lines,
    activeCourseId: active,
    activeSeatId: null,
    seats: [],
  };
}

function appliedSeatLayout(
  s: Pick<TicketState, 'seats' | 'lines' | 'activeSeatId'>,
): Pick<
  TicketState,
  'seats' | 'lines' | 'activeSeatId' | 'activeCourseId' | 'courses'
> {
  let seats = (s.seats || []).length ? s.seats : seatsFromLineIds(s.lines);
  if (seats.length === 0) seats = [{ id: newTicketSeatId() }];
  const firstId = seats[0].id;
  const tagged = s.lines.map((l) =>
    l.seatId ? l : { ...l, seatId: firstId, courseId: null },
  );
  const lines = flattenSeatGroups(groupLinesBySeat(seats, tagged));
  const active =
    s.activeSeatId && seats.some((seat) => seat.id === s.activeSeatId)
      ? s.activeSeatId
      : firstId;
  return {
    seats,
    lines,
    activeSeatId: active,
    activeCourseId: null,
    courses: [],
  };
}

// A waiter's own phone keeps the unsent cart for the whole sign-in.
try {
  if ((window as any)?.Capacitor?.isNativePlatform?.()) {
    setTicketDraftTtlMs(NATIVE_TICKET_DRAFT_TTL_MS);
  }
} catch {
  // not a browser (tests)
}

export const useTicketStore = create<TicketState>()(
  persist(
    (set) => ({
      lines: [],
      courses: [],
      seats: [],
      activeCourseId: null,
      activeSeatId: null,
      orderNote: '',
      addMode: 'default' as OrderAddMode,
      boundKey: null,
      drafts: {},
      draftUserId: null,
      userDrafts: {},
      savedAt: null,
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),
      setAddMode: (mode) => {
        const next = normalizeOrderAddMode(mode);
        if (next === 'course') {
          set((s) => ({ addMode: next, ...appliedCourseLayout(s) }));
        } else if (next === 'seat') {
          set((s) => ({ addMode: next, ...appliedSeatLayout(s) }));
        } else {
          set({ addMode: next, activeCourseId: null, activeSeatId: null });
        }
      },
      bindTable: (key, opts) =>
        set((s) => bindTicketTable(s, key, Date.now(), opts)),
      bindUser: (userId) =>
        set((s) => switchTicketDraftUser(s, userId, Date.now())),
      moveDraft: (fromKey, toKey, draft) =>
        set((s) => moveTicketDraft(s, fromKey, toKey, draft, Date.now())),
      dropOrphanLiveBills: (openKeys) =>
        set((s) => {
          const drafts = pruneLiveBillsForClosedTables(s.drafts, openKeys);
          const bound = s.boundKey;
          const boundOpen = Boolean(bound && openKeys.includes(bound));
          if (!bound || boundOpen || !draftHasLiveBill(s)) {
            return { drafts };
          }
          const empty = emptyTicketDraft();
          return {
            addMode: empty.addMode,
            // Queued Sends the till has not had yet stay on the ticket.
            lines: pendingLinesOnly(s.lines),
            courses: empty.courses,
            seats: empty.seats,
            activeCourseId: empty.activeCourseId,
            activeSeatId: empty.activeSeatId,
            orderNote: empty.orderNote,
            drafts,
            savedAt: Date.now(),
          };
        }),
      addItem: ({
        sku,
        name,
        unitPrice,
        vatRate = 0.2,
        qty,
        station,
        categoryId,
        categoryName,
        courseId: explicitCourseId,
        seatId: explicitSeatId,
      }) => {
        set((state) => {
          const drink = isImmediateFireStation(station);
          const courseId =
            state.addMode === 'course'
              ? courseIdForNewLine({
                  station,
                  explicit: explicitCourseId,
                  activeCourseId: state.activeCourseId,
                  courses: state.courses,
                })
              : drink
                ? null
                : String(explicitCourseId || '').trim() || null;
          const seatId =
            state.addMode === 'seat'
              ? seatIdForNewLine({
                  explicit: explicitSeatId,
                  activeSeatId: state.activeSeatId,
                  seats: state.seats,
                })
              : String(explicitSeatId || '').trim() || null;
          if (qty != null && Number.isFinite(qty)) {
            const line: TicketLine = {
              id: ticketLineId(sku),
              sku,
              name,
              unitPrice,
              vatRate,
              qty: Number(qty),
              staged: true,
              station,
              categoryId,
              categoryName,
              courseId: courseId || null,
              seatId: seatId || null,
            };
            return { lines: [...state.lines, line] };
          }
          const existing = state.lines.find(
            (l) =>
              l.sku === sku &&
              l.staged === true &&
              l.paid !== true &&
              (l.courseId || null) === (courseId || null) &&
              (l.seatId || null) === (seatId || null),
          );
          if (existing) {
            return {
              lines: state.lines.map((l) =>
                l.id === existing.id ? { ...l, qty: l.qty + 1 } : l,
              ),
            };
          }
          const line: TicketLine = {
            id: ticketLineId(sku),
            sku,
            name,
            unitPrice,
            vatRate,
            qty: 1,
            staged: true,
            station,
            categoryId,
            categoryName,
            courseId: courseId || null,
            seatId: seatId || null,
          };
          return { lines: [...state.lines, line] };
        });
      },
      increment: (id) =>
        set((s) => ({
          lines: s.lines.map((l) =>
            l.id === id && l.paid !== true ? { ...l, qty: l.qty + 1 } : l,
          ),
        })),
      decrement: (id) =>
        set((s) => ({
          lines: s.lines
            .map((l) =>
              l.id === id && l.paid !== true
                ? { ...l, qty: Math.max(0, l.qty - 1) }
                : l,
            )
            .filter((l) => l.qty > 0),
        })),
      removeLine: (id) =>
        set((s) => ({
          lines: s.lines.filter((l) => l.id !== id || l.paid === true),
        })),
      markLineVoided: (id) =>
        set((s) => ({
          lines: s.lines.map((l) =>
            l.id === id && l.paid !== true ? { ...l, voided: true } : l,
          ),
        })),
      markLinesAsPaid: (ids) =>
        set((s) => {
          const paid = new Set(ids);
          return {
            lines: s.lines.map((l) =>
              paid.has(l.id) ? { ...l, paid: true, staged: false } : l,
            ),
          };
        }),
      setLineNote: (id, note) =>
        set((s) => ({
          lines: s.lines.map((l) => (l.id === id ? { ...l, note } : l)),
        })),
      setOrderNote: (note) => set({ orderNote: note }),
      hydrate: ({ items, note }) =>
        set((s) => {
          const logged = items || [];
          if (logged.length === 0 && shouldKeepLocalDraftOnEmptyLog(s.lines)) {
            return s;
          }
          const fromLog: TicketLine[] = logged.map((it) => ({
            id: String(it.lineId || '').trim() || ticketLineId(it.name),
            sku: it.sku || it.name,
            name: it.name,
            unitPrice: Number(it.unitPrice),
            vatRate: Number(it.vatRate ?? 0),
            qty: Number(it.qty || 1),
            note: it.note,
            voided: it.voided === true,
            paid: it.paid === true,
            staged:
              it.fired === false && it.voided !== true && it.paid !== true,
            courseId: isImmediateFireStation(it.station)
              ? null
              : it.courseId || null,
            seatId: it.seatId || null,
            station: it.station,
            categoryId: it.categoryId,
            categoryName: it.categoryName,
            ...(it.sendKey ? { sendKey: String(it.sendKey) } : {}),
          }));
          const merged = shouldMergeLocalStagedOntoHydrated(fromLog)
            ? mergeLocalStagedOntoHydrated(fromLog, s.lines)
            : carryPendingOntoHydrated(fromLog, s.lines);
          const lines = applyLocalPaidOntoHydrated(merged, s.lines);
          const courses = coursesFromLineIds(lines, s.courses);
          const seats = seatsFromLineIds(lines, s.seats);
          const addMode = inferOrderAddMode(lines, s.addMode);
          const activeCourse =
            s.activeCourseId && courses.some((c) => c.id === s.activeCourseId)
              ? s.activeCourseId
              : (courses[0]?.id ?? null);
          const activeSeat =
            s.activeSeatId && seats.some((seat) => seat.id === s.activeSeatId)
              ? s.activeSeatId
              : (seats[0]?.id ?? null);
          return {
            lines,
            courses,
            seats,
            addMode,
            activeCourseId:
              addMode === 'course' ? activeCourse : s.activeCourseId,
            activeSeatId: addMode === 'seat' ? activeSeat : s.activeSeatId,
            orderNote: note || s.orderNote || '',
          };
        }),
      clear: () =>
        set((s) => {
          const drafts = { ...s.drafts };
          if (s.boundKey) delete drafts[s.boundKey];
          return {
            lines: [],
            orderNote: '',
            ...emptyCourses(),
            ...emptySeats(),
            drafts,
          };
        }),
      markAllAsSent: () =>
        set((s) => ({ lines: s.lines.map((l) => ({ ...l, staged: false })) })),
      markLinesAsSent: (ids, sendKey) =>
        set((s) => {
          const sent = new Set(ids);
          return {
            lines: s.lines.map((l) =>
              sent.has(l.id)
                ? { ...l, staged: false, ...(sendKey ? { sendKey } : {}) }
                : l,
            ),
          };
        }),
      markLinesAsStaged: (ids) =>
        set((s) => {
          const staged = new Set(ids);
          return {
            lines: s.lines.map((l) =>
              staged.has(l.id) && l.voided !== true && l.paid !== true
                ? { ...l, staged: true, pending: false }
                : l,
            ),
          };
        }),
      markLinesPending: (ids) =>
        set((s) => {
          const queued = new Set(ids);
          return {
            lines: s.lines.map((l) =>
              queued.has(l.id) && l.voided !== true
                ? { ...l, pending: true }
                : l,
            ),
          };
        }),
      ensureCourses: () => set((s) => appliedCourseLayout(s)),
      addCourse: () =>
        set((s) => {
          const next = { id: newTicketCourseId() };
          const courses = s.courses.length
            ? [...s.courses, next]
            : [{ id: newTicketCourseId() }, next];
          const firstId = courses[0].id;
          const lines = s.lines.map((l) =>
            l.courseId || isImmediateFireStation(l.station)
              ? l
              : { ...l, courseId: firstId },
          );
          return { courses, lines, activeCourseId: next.id };
        }),
      removeCourse: (courseId) =>
        set((s) => {
          if (s.courses.length <= 1) return s;
          const idx = s.courses.findIndex((c) => c.id === courseId);
          if (idx < 0) return s;
          const fallback =
            s.courses[idx - 1]?.id || s.courses[idx + 1]?.id || null;
          const courses = s.courses.filter((c) => c.id !== courseId);
          const lines = s.lines.map((l) =>
            l.courseId === courseId && !isImmediateFireStation(l.station)
              ? { ...l, courseId: fallback }
              : l,
          );
          const active =
            s.activeCourseId === courseId ? fallback : s.activeCourseId;
          return { courses, lines, activeCourseId: active };
        }),
      setActiveCourseId: (courseId) => set({ activeCourseId: courseId }),
      reorderCourses: (fromIndex, toIndex) =>
        set((s) => ({ courses: reorderList(s.courses, fromIndex, toIndex) })),
      moveLineToCourse: (lineId, toCourseId, toIndex) =>
        set((s) => {
          const line = s.lines.find((l) => l.id === lineId);
          if (
            !line ||
            line.staged !== true ||
            line.paid === true ||
            line.voided === true
          ) {
            return s;
          }
          return {
            lines: relocateTicketLine(
              s.courses,
              s.lines,
              lineId,
              toCourseId,
              toIndex,
            ),
          };
        }),
      ensureSeats: () => set((s) => appliedSeatLayout(s)),
      addSeat: () =>
        set((s) => {
          const next = { id: newTicketSeatId() };
          const seats = s.seats.length
            ? [...s.seats, next]
            : [{ id: newTicketSeatId() }, next];
          const firstId = seats[0].id;
          const lines = s.lines.map((l) =>
            l.seatId ? l : { ...l, seatId: firstId, courseId: null },
          );
          return { seats, lines, activeSeatId: next.id };
        }),
      removeSeat: (seatId) =>
        set((s) => {
          if (s.seats.length <= 1) return s;
          const idx = s.seats.findIndex((seat) => seat.id === seatId);
          if (idx < 0) return s;
          const fallback = s.seats[idx - 1]?.id || s.seats[idx + 1]?.id || null;
          const seats = s.seats.filter((seat) => seat.id !== seatId);
          const lines = s.lines.map((l) =>
            l.seatId === seatId ? { ...l, seatId: fallback } : l,
          );
          const active = s.activeSeatId === seatId ? fallback : s.activeSeatId;
          return { seats, lines, activeSeatId: active };
        }),
      setActiveSeatId: (seatId) => set({ activeSeatId: seatId }),
      reorderSeats: (fromIndex, toIndex) =>
        set((s) => ({ seats: reorderList(s.seats, fromIndex, toIndex) })),
      renameSeat: (seatId, name) =>
        set((s) => {
          const nextName = normalizeSeatName(name);
          return {
            seats: s.seats.map((seat) =>
              seat.id === seatId
                ? nextName
                  ? { ...seat, name: nextName }
                  : { id: seat.id }
                : seat,
            ),
          };
        }),
      moveLineToSeat: (lineId, toSeatId, toIndex) =>
        set((s) => {
          const line = s.lines.find((l) => l.id === lineId);
          if (
            !line ||
            line.staged !== true ||
            line.paid === true ||
            line.voided === true
          ) {
            return s;
          }
          return {
            lines: relocateTicketSeatLine(
              s.seats,
              s.lines,
              lineId,
              toSeatId,
              toIndex,
            ),
          };
        }),
    }),
    {
      name: 'pos-ticket',
      version: 2,
      partialize: (s) => {
        const now = Date.now();
        const parked = s.boundKey
          ? { ...snapshotTicketDraft(s), savedAt: now }
          : null;
        return {
          lines: s.lines,
          courses: s.courses,
          seats: s.seats,
          activeCourseId: s.activeCourseId,
          activeSeatId: s.activeSeatId,
          orderNote: s.orderNote,
          addMode: s.addMode,
          boundKey: s.boundKey,
          savedAt: now,
          draftUserId: s.draftUserId,
          userDrafts: s.userDrafts,
          drafts: pruneStaleTicketDrafts(
            {
              ...s.drafts,
              ...(s.boundKey && parked ? { [s.boundKey]: parked } : {}),
            },
            now,
          ),
        };
      },
      migrate: (persisted) => {
        const raw = persisted as TicketDraft & {
          drafts?: Record<string, TicketDraft>;
          boundKey?: string | null;
          draftUserId?: number | null;
          userDrafts?: Record<string, Record<string, TicketDraft>>;
        };
        return revivePersistedTicketDraft({
          draftUserId: raw?.draftUserId ?? null,
          userDrafts: raw?.userDrafts || {},
          addMode: raw?.addMode || 'default',
          lines: (raw?.lines || []) as TicketLine[],
          courses: raw?.courses || [],
          seats: raw?.seats || [],
          activeCourseId: raw?.activeCourseId ?? null,
          activeSeatId: raw?.activeSeatId ?? null,
          orderNote: raw?.orderNote || '',
          savedAt: raw?.savedAt ?? null,
          drafts: raw?.drafts || {},
          boundKey: raw?.boundKey ?? null,
        });
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) queueMicrotask(finishTicketHydration);
      },
    },
  ),
);

// localStorage is synchronous, so persist hydrates inside create(), before
// `useTicketStore` is assigned. Touching the store from onRehydrateStorage
// there throws a TDZ error that persist swallows, and hasHydrated then stays
// false for the life of the page — only the deferred error path may use it.
function finishTicketHydration(): void {
  const s = useTicketStore.getState();
  const revived = revivePersistedTicketDraft({
    addMode: s.addMode,
    lines: s.lines,
    courses: s.courses,
    seats: s.seats,
    activeCourseId: s.activeCourseId,
    activeSeatId: s.activeSeatId,
    orderNote: s.orderNote,
    savedAt: s.savedAt ?? undefined,
    drafts: s.drafts || {},
  });
  useTicketStore.setState({
    ...revived,
    savedAt: revived.savedAt ?? Date.now(),
  });
  const next = useTicketStore.getState();
  if (next.addMode === 'course') next.ensureCourses();
  if (next.addMode === 'seat') next.ensureSeats();
  // Carts saved under another waiter are not this one's.
  next.bindUser(useSessionStore.getState().user?.id);
  useTicketStore.setState({ hasHydrated: true });
}

// A waiter signing in gets their own carts, never the last waiter's
// (`switchTicketDraftUser`). Signing out keeps them for when they return.
useSessionStore.subscribe((state, prev) => {
  const id = state.user?.id;
  if (id == null || id === prev.user?.id) return;
  if (!useTicketStore.getState().hasHydrated) return;
  useTicketStore.getState().bindUser(id);
});

if (!useTicketStore.persist) {
  useTicketStore.setState({ hasHydrated: true });
} else {
  useTicketStore.persist.onFinishHydration(finishTicketHydration);
  if (useTicketStore.persist.hasHydrated()) finishTicketHydration();
}
