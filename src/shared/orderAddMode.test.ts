import { describe, expect, it } from 'vitest';
import { inferOrderAddMode, normalizeOrderAddMode } from './orderAddMode';

describe('normalizeOrderAddMode', () => {
  it('defaults to unconstrained adding', () => {
    expect(normalizeOrderAddMode(undefined)).toBe('default');
    expect(normalizeOrderAddMode('')).toBe('default');
    expect(normalizeOrderAddMode('DEFAULT')).toBe('default');
  });

  it('accepts course and seat', () => {
    expect(normalizeOrderAddMode('course')).toBe('course');
    expect(normalizeOrderAddMode('seat')).toBe('seat');
  });
});

describe('inferOrderAddMode', () => {
  it('prefers course when kitchen lines are tagged', () => {
    expect(
      inferOrderAddMode([
        { courseId: 'c1', station: 'KITCHEN' },
        { seatId: 's1', station: 'BAR' },
      ]),
    ).toBe('course');
  });

  it('uses seat when lines carry seat ids', () => {
    expect(inferOrderAddMode([{ seatId: 's1' }], 'default')).toBe('seat');
  });
});
