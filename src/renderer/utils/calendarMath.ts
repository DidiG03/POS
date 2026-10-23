/**
 * Month and year steps that stay in the month they land on.
 *
 * `setMonth` overflows: 31 October minus one month is "31 September", which
 * JavaScript turns into 1 October — so on the 31st, Review's "Last month"
 * showed this month. The day is clamped to the target month's last day.
 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  const day = out.getDate();
  out.setDate(1);
  out.setMonth(out.getMonth() + n);
  out.setDate(Math.min(day, daysInMonth(out.getFullYear(), out.getMonth())));
  return out;
}

export function addYears(d: Date, n: number): Date {
  return addMonths(d, n * 12);
}

/**
 * `n` calendar days later (or earlier), same wall-clock time. Adding
 * 24-hour blocks breaks on the days the clocks change: from 00:00 on the
 * 25-hour autumn day, +24h is 23:00 the same day.
 */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
