export const ORDER_ADD_MODES = ['default', 'course', 'seat'] as const;

export type OrderAddMode = (typeof ORDER_ADD_MODES)[number];

export function isOrderAddMode(raw: unknown): raw is OrderAddMode {
  return raw === 'default' || raw === 'course' || raw === 'seat';
}

export function normalizeOrderAddMode(raw: unknown): OrderAddMode {
  return isOrderAddMode(raw) ? raw : 'default';
}

export function inferOrderAddMode(
  lines: Array<{
    courseId?: string | null;
    seatId?: string | null;
    station?: string | null;
  }>,
  fallback: OrderAddMode = 'default',
): OrderAddMode {
  const hasCourse = lines.some(
    (l) =>
      String(l.courseId || '').trim() &&
      String(l.station || '').toUpperCase() !== 'BAR',
  );
  if (hasCourse) return 'course';
  if (lines.some((l) => String(l.seatId || '').trim())) return 'seat';
  return normalizeOrderAddMode(fallback);
}
