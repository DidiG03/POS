import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ticketLineId } from '@shared/utils/ticketLineId';
import { isImmediateFireStation } from '@shared/ticketCourseFire';
import {
  inferOrderAddMode,
  normalizeOrderAddMode,
  type OrderAddMode,
} from '@shared/orderAddMode';
import {
  bindTicketTable,
  mergeLocalStagedOntoHydrated,
  pruneStaleTicketDrafts,
  revivePersistedTicketDraft,
  applyLocalPaidOntoHydrated,
  shouldKeepLocalDraftOnEmptyLog,
  shouldMergeLocalStagedOntoHydrated,
  snapshotTicketDraft,
  type TicketDraft,
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
  savedAt: number | null;
  hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
  setAddMode: (mode: OrderAddMode) => void;
  bindTable: (key: string | null) => void;
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
  markLinesAsSent: (ids: string[]) => void;
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

export const useTicketStore = create<TicketState>()(
  persist(
    (set, get) => ({
      lines: [],
      courses: [],
      seats: [],
      activeCourseId: null,
      activeSeatId: null,
      orderNote: '',
      addMode: 'default' as OrderAddMode,
      boundKey: null,
      drafts: {},
      savedAt: null,
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),
      setAddMode: (mode) => {
        const next = normalizeOrderAddMode(mode);
        set({ addMode: next });
        if (next === 'course') get().ensureCourses();
        else if (next === 'seat') get().ensureSeats();
        else set({ activeCourseId: null, activeSeatId: null });
      },
      bindTable: (key) => set((s) => bindTicketTable(s, key)),
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
            id: ticketLineId(it.name),
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
          }));
          const merged = shouldMergeLocalStagedOntoHydrated(fromLog)
            ? mergeLocalStagedOntoHydrated(fromLog, s.lines)
            : fromLog;
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
      markLinesAsSent: (ids) =>
        set((s) => {
          const sent = new Set(ids);
          return {
            lines: s.lines.map((l) =>
              sent.has(l.id) ? { ...l, staged: false } : l,
            ),
          };
        }),
      ensureCourses: () =>
        set((s) => {
          let courses = s.courses.length
            ? s.courses
            : coursesFromLineIds(s.lines);
          if (courses.length === 0) courses = [{ id: newTicketCourseId() }];
          const firstId = courses[0].id;
          const drinks = s.lines.filter((l) =>
            isImmediateFireStation(l.station),
          );
          const food = s.lines.filter(
            (l) => !isImmediateFireStation(l.station),
          );
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
        }),
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
      ensureSeats: () =>
        set((s) => {
          let seats = (s.seats || []).length
            ? s.seats
            : seatsFromLineIds(s.lines);
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
        }),
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
        };
        return revivePersistedTicketDraft({
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
      onRehydrateStorage: () => (state) => {
        if (state) {
          const revived = revivePersistedTicketDraft({
            addMode: state.addMode,
            lines: state.lines,
            courses: state.courses,
            seats: state.seats,
            activeCourseId: state.activeCourseId,
            activeSeatId: state.activeSeatId,
            orderNote: state.orderNote,
            savedAt: state.savedAt ?? undefined,
            drafts: state.drafts || {},
          });
          useTicketStore.setState({
            ...revived,
            savedAt: revived.savedAt ?? Date.now(),
            hasHydrated: true,
          });
          return;
        }
        useTicketStore.setState({ hasHydrated: true });
      },
    },
  ),
);

if (typeof useTicketStore.persist?.onFinishHydration === 'function') {
  useTicketStore.persist.onFinishHydration(() => {
    const s = useTicketStore.getState();
    if (s.addMode === 'course') s.ensureCourses();
    if (s.addMode === 'seat') s.ensureSeats();
    useTicketStore.setState({ hasHydrated: true });
  });
  if (useTicketStore.persist.hasHydrated()) {
    const s = useTicketStore.getState();
    if (s.addMode === 'course') s.ensureCourses();
    if (s.addMode === 'seat') s.ensureSeats();
    useTicketStore.setState({ hasHydrated: true });
  }
}
