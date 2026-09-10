export function isImmediateFireStation(station?: string | null): boolean {
  return (
    String(station || '')
      .trim()
      .toUpperCase() === 'BAR'
  );
}

export function drinkLines<T extends { station?: string | null }>(
  lines: T[],
): T[] {
  return lines.filter((l) => isImmediateFireStation(l.station));
}

export function kitchenLines<T extends { station?: string | null }>(
  lines: T[],
): T[] {
  return lines.filter((l) => !isImmediateFireStation(l.station));
}

export function courseKeyFromItems(
  items: Array<{ courseId?: string | null; station?: string | null }> | unknown,
): string {
  const arr = Array.isArray(items) ? items : [];
  const kitchen = arr.find(
    (it) =>
      !isImmediateFireStation(it?.station) && String(it?.courseId || '').trim(),
  );
  return kitchen ? String(kitchen.courseId).trim() : '';
}

export type FireableLine = {
  id: string;
  staged?: boolean;
  voided?: boolean;
  courseId?: string | null;
  station?: string | null;
};

export function isUnfiredLine(line: FireableLine): boolean {
  return line.staged === true && line.voided !== true;
}

/** Unfired kitchen lines on this course. Drinks are never part of a course. */
export function linesForCourseFire<T extends FireableLine>(
  lines: T[],
  courseId: string,
): T[] {
  const cid = String(courseId || '').trim();
  if (!cid) return [];
  return kitchenLines(lines).filter(
    (line) => isUnfiredLine(line) && String(line.courseId || '').trim() === cid,
  );
}

export function firstHeldCourseId(
  courses: Array<{ id: string }>,
  lines: FireableLine[],
): string | null {
  for (const c of courses) {
    if (linesForCourseFire(lines, c.id).length) return c.id;
  }
  return null;
}

/**
 * Course-mode fire batch: unfired drinks first (own ticket), then the
 * kitchen course being sent. Later Fire taps do not wait on drinks —
 * leftover drinks still go first so the bar slip prints before food.
 */
export function selectFireLines<T extends FireableLine>(opts: {
  lines: T[];
  courses: Array<{ id: string }>;
  courseMode: boolean;
  courseId?: string | null;
  firstSend: boolean;
}): T[] {
  const unfired = opts.lines.filter(isUnfiredLine);
  if (!opts.courseMode) return unfired;
  const drinks = drinkLines(unfired);
  const target =
    String(opts.courseId || '').trim() ||
    (opts.firstSend
      ? opts.courses[0]?.id
      : firstHeldCourseId(opts.courses, opts.lines)) ||
    '';
  const kitchen = target ? linesForCourseFire(opts.lines, target) : [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const line of [...drinks, ...kitchen]) {
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    out.push(line);
  }
  return out;
}

export function courseNumber(
  courses: Array<{ id: string }>,
  courseId: string | null | undefined,
): number | null {
  const id = String(courseId || '').trim();
  if (!id) return null;
  const i = courses.findIndex((c) => c.id === id);
  return i >= 0 ? i + 1 : null;
}

export function kitchenSlipNeedsCourseBanner(
  items: Array<{ station?: string | null }>,
): boolean {
  return items.some((it) => !isImmediateFireStation(it.station));
}
