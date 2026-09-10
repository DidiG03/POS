/** Weekday × hour order density for the Review heatmap. Sunday = 0. */

export type ReviewHeatmapCell = {
  dayOfWeek: number;
  hour: number;
  orders: number;
  revenue: number;
};

export const HEATMAP_DAYS_MON_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

export function emptyReviewHeatmap(): ReviewHeatmapCell[] {
  const cells: ReviewHeatmapCell[] = [];
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({ dayOfWeek, hour, orders: 0, revenue: 0 });
    }
  }
  return cells;
}

export function reviewHeatmapIndex(dayOfWeek: number, hour: number): number {
  return dayOfWeek * 24 + hour;
}

export function heatmapHourRange(
  cells: ReviewHeatmapCell[],
): { start: number; end: number } | null {
  let start = 24;
  let end = -1;
  for (const cell of cells) {
    if (cell.orders <= 0) continue;
    if (cell.hour < start) start = cell.hour;
    if (cell.hour > end) end = cell.hour;
  }
  if (end < 0) return null;
  return { start, end };
}

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(n));
  const f = n / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Four legend steps. max 2000 → 200 / 500 / 1,000 / 2,000. */
export function heatmapThresholds(
  maxOrders: number,
): [number, number, number, number] {
  const top = niceCeil(Math.max(1, maxOrders));
  const t1 = Math.max(1, Math.round(top * 0.1));
  const t2 = Math.max(t1 + 1, Math.round(top * 0.25));
  const t3 = Math.max(t2 + 1, Math.round(top * 0.5));
  const t4 = Math.max(t3 + 1, top);
  return [t1, t2, t3, t4];
}

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

export function heatmapLevel(
  orders: number,
  thresholds: [number, number, number, number],
): HeatmapLevel {
  if (orders <= 0) return 0;
  if (orders >= thresholds[3]) return 4;
  if (orders >= thresholds[2]) return 3;
  if (orders >= thresholds[1]) return 2;
  return 1;
}

export function heatmapMaxOrders(cells: ReviewHeatmapCell[]): number {
  let max = 0;
  for (const cell of cells) {
    if (cell.orders > max) max = cell.orders;
  }
  return max;
}

export function heatmapHasOrders(
  cells: ReviewHeatmapCell[] | undefined,
): boolean {
  if (!cells) return false;
  return cells.some((c) => c.orders > 0);
}
