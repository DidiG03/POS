/**
 * Table states on the floor plan (till, Waiter app, web waiter):
 *
 *   free            nobody at it;
 *   seated          open, nothing ordered yet;
 *   ordered         food or drinks sent, the kitchen still on it;
 *   served          everything sent is done in the kitchen;
 *   billRequested   the bill was printed after the last order;
 *   paid            paid in the last few minutes: to be cleared.
 *
 * Each has its own colour, icon and word (not colour alone), and a timer
 * since the last thing that happened at the table. A table idle longer
 * than the venue's limit is highlighted.
 */

export type TableFloorState =
  | 'free'
  | 'seated'
  | 'ordered'
  | 'served'
  | 'billRequested'
  | 'paid';

export interface FloorThresholds {
  /** Minutes without anything happening before an open table is flagged. */
  idleMinutes: number;
  /** Minutes a paid table shows "to clear". */
  clearMinutes: number;
}

export const DEFAULT_FLOOR_THRESHOLDS: FloorThresholds = {
  idleMinutes: 30,
  clearMinutes: 10,
};

export function floorThresholds(settings: any): FloorThresholds {
  const f = settings?.preferences?.floor || {};
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    idleMinutes: n(f.idleMinutes, 5, 240, DEFAULT_FLOOR_THRESHOLDS.idleMinutes),
    clearMinutes: n(
      f.clearMinutes,
      1,
      60,
      DEFAULT_FLOOR_THRESHOLDS.clearMinutes,
    ),
  };
}

export interface FloorRowFacts {
  open: boolean;
  /** Live (not voided) lines on the bill. */
  hasItems: boolean;
  /** Kitchen state of what was sent: none on a display, cooking, all done. */
  kitchen?: 'none' | 'cooking' | 'served';
  openedAt?: string | null;
  /** Last order sent (or the open time). */
  lastActionAt?: string | null;
  billPrintedAt?: string | null;
  /** Closed by a payment at this time, when it was recent. */
  paidAt?: string | null;
}

export function tableFloorState(
  f: FloorRowFacts,
  now: number,
  th: FloorThresholds = DEFAULT_FLOOR_THRESHOLDS,
): TableFloorState {
  if (!f.open) {
    const paid = Date.parse(String(f.paidAt || ''));
    return Number.isFinite(paid) && now - paid < th.clearMinutes * 60_000
      ? 'paid'
      : 'free';
  }
  if (!f.hasItems) return 'seated';
  const bill = Date.parse(String(f.billPrintedAt || ''));
  const last = Date.parse(String(f.lastActionAt || f.openedAt || ''));
  if (Number.isFinite(bill) && (!Number.isFinite(last) || bill >= last)) {
    return 'billRequested';
  }
  if (f.kitchen === 'served') return 'served';
  return 'ordered';
}

/** Minutes since the last action (paid: since payment), or null. */
export function tableTimerMinutes(
  f: FloorRowFacts,
  now: number,
): number | null {
  const at = Date.parse(
    String((f.open ? f.lastActionAt || f.openedAt : f.paidAt) || ''),
  );
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / 60_000));
}

/** Open and nothing has happened for longer than the venue allows. */
export function tableIsIdle(
  f: FloorRowFacts,
  now: number,
  th: FloorThresholds = DEFAULT_FLOOR_THRESHOLDS,
): boolean {
  if (!f.open) return false;
  const m = tableTimerMinutes(f, now);
  return m != null && m >= th.idleMinutes;
}

/** "25m", "1h05". */
export function formatTableTimer(minutes: number | null): string {
  if (minutes == null) return '';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return `${h}h${String(minutes % 60).padStart(2, '0')}`;
}

/** Colour class, icon and legend word key per state. */
export const TABLE_STATE_LOOK: Record<
  TableFloorState,
  { cls: string; icon: string }
> = {
  free: { cls: '', icon: '' },
  seated: { cls: 'bg-sky-700', icon: '◌' },
  ordered: { cls: 'bg-amber-600', icon: '◐' },
  served: { cls: 'bg-emerald-700', icon: '●' },
  billRequested: { cls: 'bg-violet-700', icon: '€' },
  paid: {
    cls: 'bg-zinc-600 outline-dashed outline-2 outline-offset-2 outline-zinc-200',
    icon: '✓',
  },
};
