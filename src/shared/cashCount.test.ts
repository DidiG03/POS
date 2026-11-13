import { describe, expect, it } from 'vitest';
import {
  cashCountAtClockOut,
  cashCountResult,
  parseCountedCash,
} from './cashCount';

describe('cash count', () => {
  it('is off unless the venue turns it on', () => {
    expect(cashCountAtClockOut({})).toBe(false);
    expect(
      cashCountAtClockOut({ preferences: { cashCountAtClockOut: true } }),
    ).toBe(true);
  });

  it('reads what was typed, with a comma or a dot', () => {
    expect(parseCountedCash('120')).toBe(120);
    expect(parseCountedCash('95,50')).toBe(95.5);
    expect(parseCountedCash(' 1 200.5 ')).toBe(1200.5);
    expect(parseCountedCash('')).toBeNull();
    expect(parseCountedCash('-5')).toBeNull();
    expect(parseCountedCash('12.345')).toBeNull();
    expect(parseCountedCash('abc')).toBeNull();
    expect(parseCountedCash(0)).toBe(0);
  });

  it('says how much is over or short', () => {
    expect(cashCountResult(100, 95)).toEqual({
      expected: 100,
      counted: 95,
      difference: -5,
    });
    expect(cashCountResult(100, 100.001).difference).toBe(0);
    expect(cashCountResult(80.1, 80.3).difference).toBe(0.2);
  });
});
