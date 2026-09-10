import { describe, expect, it } from 'vitest';
import {
  courseKeyFromItems,
  firstHeldCourseId,
  kitchenSlipNeedsCourseBanner,
  linesForCourseFire,
  selectFireLines,
} from './ticketCourseFire';

describe('ticketCourseFire', () => {
  const courses = [{ id: 'c1' }, { id: 'c2' }];
  const lines = [
    { id: 's', staged: true, courseId: 'c1', station: 'KITCHEN' },
    { id: 'p', staged: true, courseId: 'c2', station: 'KITCHEN' },
    { id: 'd', staged: true, courseId: null, station: 'BAR' },
  ];

  it('fires only the named course kitchen — drinks are not a course', () => {
    expect(linesForCourseFire(lines, 'c1').map((l) => l.id)).toEqual(['s']);
    expect(linesForCourseFire(lines, 'c2').map((l) => l.id)).toEqual(['p']);
  });

  it('picks the first course that still has kitchen to fire', () => {
    expect(firstHeldCourseId(courses, lines)).toBe('c1');
    const afterStarters = lines.map((l) =>
      l.id === 's' ? { ...l, staged: false } : l,
    );
    expect(firstHeldCourseId(courses, afterStarters)).toBe('c2');
  });

  it('ignores leftover drinks when choosing the next kitchen course', () => {
    expect(
      firstHeldCourseId(courses, [
        { id: 's', staged: false, courseId: 'c1', station: 'KITCHEN' },
        { id: 'p', staged: true, courseId: 'c2', station: 'KITCHEN' },
        { id: 'd', staged: true, courseId: null, station: 'BAR' },
      ]),
    ).toBe('c2');
  });

  it('puts drinks first, then the course being sent', () => {
    expect(
      selectFireLines({
        lines,
        courses,
        courseMode: true,
        firstSend: true,
      }).map((l) => l.id),
    ).toEqual(['d', 's']);
    const afterStarters = lines.map((l) =>
      l.id === 's' || l.id === 'd' ? { ...l, staged: false } : l,
    );
    expect(
      selectFireLines({
        lines: afterStarters,
        courses,
        courseMode: true,
        firstSend: false,
      }).map((l) => l.id),
    ).toEqual(['p']);
  });

  it('still sends leftover drinks first when firing a later course', () => {
    expect(
      selectFireLines({
        lines,
        courses,
        courseMode: true,
        courseId: 'c2',
        firstSend: false,
      }).map((l) => l.id),
    ).toEqual(['d', 'p']);
  });

  it('default mode still fires every unsent line', () => {
    expect(
      selectFireLines({
        lines,
        courses,
        courseMode: false,
        firstSend: true,
      }).map((l) => l.id),
    ).toEqual(['s', 'p', 'd']);
  });

  it('keys a kitchen ticket by food courseId and ignores drinks', () => {
    expect(
      courseKeyFromItems([
        { courseId: 'c1', station: 'KITCHEN' },
        { courseId: 'c2', station: 'BAR' },
      ]),
    ).toBe('c1');
    expect(courseKeyFromItems([{ name: 'Cola', station: 'BAR' }])).toBe('');
    expect(courseKeyFromItems([{ name: 'Soup', station: 'KITCHEN' }])).toBe('');
  });

  it('omits the course banner on drinks-only slips', () => {
    expect(kitchenSlipNeedsCourseBanner([{ station: 'BAR' }])).toBe(false);
    expect(
      kitchenSlipNeedsCourseBanner([
        { station: 'KITCHEN' },
        { station: 'BAR' },
      ]),
    ).toBe(true);
  });
});
