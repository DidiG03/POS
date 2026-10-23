import { describe, expect, it } from 'vitest';
import { clockOutForceAllowed, withShiftLock } from './shiftClock';

describe('withShiftLock', () => {
  it('runs one clock action per person at a time', async () => {
    const open: number[] = [];
    const clockIn = () =>
      withShiftLock(7, async () => {
        // Check-then-create, the way the handlers do it.
        const already = open.length > 0;
        await new Promise((r) => setTimeout(r, 5));
        if (!already) open.push(7);
      });
    await Promise.all([clockIn(), clockIn(), clockIn()]);
    expect(open).toEqual([7]);
  });
});

describe('clockOutForceAllowed', () => {
  it('lets only a manager skip the open-tables check', () => {
    expect(clockOutForceAllowed(true, 'ADMIN')).toBe(true);
    expect(clockOutForceAllowed(true, 'WAITER')).toBe(false);
    expect(clockOutForceAllowed(true, undefined)).toBe(false);
    expect(clockOutForceAllowed('true', 'ADMIN')).toBe(false);
    expect(clockOutForceAllowed(false, 'ADMIN')).toBe(false);
  });
});
