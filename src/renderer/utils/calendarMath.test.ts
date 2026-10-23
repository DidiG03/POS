import { describe, expect, it } from 'vitest';
import { addMonths, addYears } from './calendarMath';

const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

describe('addMonths', () => {
  it('stays in the previous month on the 31st', () => {
    expect(ymd(addMonths(new Date(2026, 9, 31), -1))).toEqual([2026, 9, 30]);
    expect(ymd(addMonths(new Date(2026, 2, 31), -1))).toEqual([2026, 2, 28]);
    expect(ymd(addMonths(new Date(2026, 3, 30), -2))).toEqual([2026, 2, 28]);
  });

  it('keeps the day and time when the month has it', () => {
    const d = addMonths(new Date(2026, 9, 23, 14, 5), -1);
    expect(ymd(d)).toEqual([2026, 9, 23]);
    expect([d.getHours(), d.getMinutes()]).toEqual([14, 5]);
    expect(ymd(addMonths(new Date(2026, 0, 31), -1))).toEqual([2025, 12, 31]);
  });
});

describe('addYears', () => {
  it('turns 29 February into 28 February', () => {
    expect(ymd(addYears(new Date(2028, 1, 29), -1))).toEqual([2027, 2, 28]);
  });
});

describe('addDays across the clock change (Europe/Tirane)', () => {
  it('moves one calendar day from 25 October and to 29 March', async () => {
    const prev = process.env.TZ;
    process.env.TZ = 'Europe/Tirane';
    try {
      const { addDays } = await import('./calendarMath');
      // 25 October 2026 is 25 hours long.
      expect(ymd(addDays(new Date(2026, 9, 25), 1))).toEqual([2026, 10, 26]);
      // 29 March 2026 is 23 hours long.
      expect(ymd(addDays(new Date(2026, 2, 30), -1))).toEqual([2026, 3, 29]);
      expect(addDays(new Date(2026, 9, 25), 1).getHours()).toBe(0);
    } finally {
      process.env.TZ = prev;
    }
  });
});
