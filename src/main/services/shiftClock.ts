/**
 * Clock-in and clock-out, one at a time per person, for the till
 * (`shifts:clockIn/clockOut`) and phones (`POST /shifts/clock-in|clock-out`).
 *
 * Both are check-then-write. A double tap, or a phone replaying a queued
 * clock-in while the till handled the first, opened two shifts for one
 * waiter: clock-out closed only one, and every shift summary after that
 * counted the overlapping sales twice.
 */
import { KeyedAsyncMutex } from '@shared/asyncMutex';

const shiftLocks = new KeyedAsyncMutex();

export function withShiftLock<T>(
  userId: number,
  fn: () => Promise<T>,
): Promise<T> {
  return shiftLocks.runExclusive(String(userId), fn, 10_000);
}

/**
 * Clocking out past the open-tables check strands those tables with an
 * off-shift owner. Only a manager closing someone's shift may skip it.
 */
export function clockOutForceAllowed(force: unknown, role: unknown): boolean {
  return force === true && String(role || '').toUpperCase() === 'ADMIN';
}
