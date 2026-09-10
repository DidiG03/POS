import { describe, expect, it } from 'vitest';
import {
  courseIdForNewLine,
  flattenCourseGroups,
  groupLinesByCourse,
  moveLineToCourse,
  partitionCourseBoardLines,
  reorderList,
} from './ticketCourses';

describe('ticketCourses', () => {
  const courses = [{ id: 'c1' }, { id: 'c2' }];
  const lines = [
    { id: 'a', courseId: 'c1' },
    { id: 'b', courseId: 'c1' },
    { id: 'c', courseId: 'c2' },
  ];

  it('groups lines under course separators, including empty courses', () => {
    const groups = groupLinesByCourse([...courses, { id: 'c3' }], lines);
    expect(groups.map((g) => [g.course.id, g.lines.map((l) => l.id)])).toEqual([
      ['c1', ['a', 'b']],
      ['c2', ['c']],
      ['c3', []],
    ]);
  });

  it('reorders course separators', () => {
    expect(reorderList(courses, 0, 1).map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('moves a line into another course at an index', () => {
    const next = moveLineToCourse(courses, lines, 'b', 'c2', 0);
    expect(next.map((l) => [l.id, l.courseId])).toEqual([
      ['a', 'c1'],
      ['b', 'c2'],
      ['c', 'c2'],
    ]);
  });

  it('reorders within the same course', () => {
    const next = moveLineToCourse(courses, lines, 'a', 'c1', 1);
    expect(next.map((l) => l.id)).toEqual(['b', 'a', 'c']);
  });

  it('round-trips flatten after grouping', () => {
    const groups = groupLinesByCourse(courses, lines);
    expect(flattenCourseGroups(groups).map((l) => l.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps drinks outside course groups', () => {
    const { drinks, groups } = partitionCourseBoardLines(courses, [
      ...lines,
      { id: 'cola', courseId: 'c1', station: 'BAR' },
    ]);
    expect(drinks.map((l) => l.id)).toEqual(['cola']);
    expect(groups.map((g) => g.lines.map((l) => l.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('assigns a new kitchen line to the selected course, not the first', () => {
    expect(
      courseIdForNewLine({
        station: 'KITCHEN',
        explicit: null,
        activeCourseId: 'c2',
        courses,
      }),
    ).toBe('c2');
    expect(
      courseIdForNewLine({
        station: 'BAR',
        explicit: 'c2',
        activeCourseId: 'c2',
        courses,
      }),
    ).toBe(null);
  });

  it('does not move a drink into a course', () => {
    const mixed = [
      { id: 'a', courseId: 'c1', station: 'KITCHEN' },
      { id: 'cola', courseId: null, station: 'BAR' },
    ];
    const next = moveLineToCourse(courses, mixed, 'cola', 'c2', 0);
    expect(next.find((l) => l.id === 'cola')?.courseId ?? null).toBe(null);
  });
});
