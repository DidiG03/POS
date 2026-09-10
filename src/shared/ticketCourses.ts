import { isImmediateFireStation } from './ticketCourseFire';

export type TicketCourse = { id: string };

export function newTicketCourseId(): string {
  return `course-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function coursesFromLineIds<T extends { courseId?: string | null }>(
  lines: T[],
  existing?: TicketCourse[],
): TicketCourse[] {
  const seen = new Set<string>();
  const out: TicketCourse[] = [];
  for (const c of existing || []) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id });
  }
  for (const line of lines) {
    const id = String(line.courseId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id });
  }
  return out;
}

export function groupLinesByCourse<T extends { courseId?: string | null }>(
  courses: TicketCourse[],
  lines: T[],
): Array<{ course: TicketCourse; lines: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const c of courses) buckets.set(c.id, []);
  const ungrouped: T[] = [];
  for (const line of lines) {
    const id = String(line.courseId || '').trim();
    const bucket = id ? buckets.get(id) : undefined;
    if (bucket) bucket.push(line);
    else ungrouped.push(line);
  }
  const groups = courses.map((course) => ({
    course,
    lines: buckets.get(course.id) || [],
  }));
  if (ungrouped.length) {
    if (groups[0])
      groups[0] = { ...groups[0], lines: [...ungrouped, ...groups[0].lines] };
    else groups.push({ course: { id: newTicketCourseId() }, lines: ungrouped });
  }
  return groups;
}

/** Drinks stay outside courses; food is grouped under course separators. */
export function partitionCourseBoardLines<
  T extends { courseId?: string | null; station?: string | null },
>(
  courses: TicketCourse[],
  lines: T[],
): { drinks: T[]; groups: Array<{ course: TicketCourse; lines: T[] }> } {
  const drinks: T[] = [];
  const food: T[] = [];
  for (const line of lines) {
    if (isImmediateFireStation(line.station)) drinks.push(line);
    else food.push(line);
  }
  return { drinks, groups: groupLinesByCourse(courses, food) };
}

/** Prefer the waiter's selected course; drinks never join a course. */
export function courseIdForNewLine(input: {
  station?: string | null;
  explicit?: string | null;
  activeCourseId?: string | null;
  courses: Array<{ id: string }>;
}): string | null {
  if (isImmediateFireStation(input.station)) return null;
  const explicit = String(input.explicit || '').trim();
  if (explicit) return explicit;
  const active = String(input.activeCourseId || '').trim();
  if (active) return active;
  return input.courses[0]?.id || null;
}

export function flattenCourseGroups<T>(
  groups: Array<{ course: TicketCourse; lines: T[] }>,
): T[] {
  return groups.flatMap((g) =>
    g.lines.map((line) => ({ ...line, courseId: g.course.id })),
  );
}

export function reorderList<T>(items: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items;
  }
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Move a line into `toCourseId` at `toIndex` (index among that course's
 * lines after the item has been removed from its source).
 */
export function moveLineToCourse<
  T extends { id: string; courseId?: string | null },
>(
  courses: TicketCourse[],
  lines: T[],
  lineId: string,
  toCourseId: string,
  toIndex: number,
): T[] {
  const current = lines.find((l) => l.id === lineId);
  if (
    current &&
    isImmediateFireStation((current as { station?: string | null }).station)
  ) {
    return lines;
  }
  const groups = groupLinesByCourse(courses, lines);
  let moved: T | undefined;
  for (const g of groups) {
    const idx = g.lines.findIndex((l) => l.id === lineId);
    if (idx < 0) continue;
    moved = g.lines[idx];
    g.lines = g.lines.filter((l) => l.id !== lineId);
    break;
  }
  if (!moved) return lines;
  const dest = groups.find((g) => g.course.id === toCourseId);
  if (!dest) {
    return flattenCourseGroups(groups).concat({
      ...moved,
      courseId: toCourseId,
    });
  }
  const insertAt = Math.max(
    0,
    Math.min(Math.floor(toIndex), dest.lines.length),
  );
  dest.lines = [
    ...dest.lines.slice(0, insertAt),
    { ...moved, courseId: toCourseId },
    ...dest.lines.slice(insertAt),
  ];
  return flattenCourseGroups(groups);
}
