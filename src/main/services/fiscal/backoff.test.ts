/**
 * Backoff policy: exponential, jittered, capped at 30s.
 */

import { describe, expect, it } from 'vitest';
import { BACKOFF_CAP_MS, backoffDelayMs, backoffSchedule } from './backoff';

/** Deterministic jitter at each extreme. */
const low = { random: () => 0 };
const high = { random: () => 0.999999 };

describe('backoffDelayMs', () => {
  it('doubles per attempt', () => {
    expect(backoffDelayMs(1, low)).toBe(500);
    expect(backoffDelayMs(2, low)).toBe(1000);
    expect(backoffDelayMs(3, low)).toBe(2000);
    expect(backoffDelayMs(4, low)).toBe(4000);
  });

  it('never exceeds the 30s cap, however many attempts', () => {
    for (const attempt of [1, 5, 10, 20, 100, 5000]) {
      expect(backoffDelayMs(attempt, high)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    }
  });

  it('does not overflow into Infinity at absurd attempt counts', () => {
    // 2 ** (n - 1) goes infinite past ~1024, which would defeat the cap.
    expect(Number.isFinite(backoffDelayMs(100_000, high))).toBe(true);
  });

  it('jitters within half the ceiling, never to zero', () => {
    // A near-zero wait would ask for a status before the provider can have
    // finished writing the document.
    const ceiling = 4000;
    expect(backoffDelayMs(3, low)).toBe(ceiling / 2);
    expect(backoffDelayMs(3, high)).toBeGreaterThan(ceiling / 2);
    expect(backoffDelayMs(3, high)).toBeLessThanOrEqual(ceiling);
  });

  it('actually varies between calls', () => {
    const seen = new Set(Array.from({ length: 200 }, () => backoffDelayMs(4)));
    expect(seen.size).toBeGreaterThan(20);
  });

  it('treats a non-positive attempt as the first', () => {
    expect(backoffDelayMs(0, low)).toBe(backoffDelayMs(1, low));
    expect(backoffDelayMs(-5, low)).toBe(backoffDelayMs(1, low));
  });

  it('honours an overridden base and cap', () => {
    expect(backoffDelayMs(1, { ...low, baseMs: 200 })).toBe(100);
    expect(backoffDelayMs(50, { ...high, capMs: 5000 })).toBeLessThanOrEqual(
      5000,
    );
  });
});

describe('backoffSchedule', () => {
  it('reaches and holds the cap', () => {
    const schedule = backoffSchedule(12, low);
    expect(schedule[0]).toBe(500);
    expect(schedule.at(-1)).toBe(BACKOFF_CAP_MS / 2);
    expect(Math.max(...schedule)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    // Monotonic until it saturates.
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]!).toBeGreaterThanOrEqual(schedule[i - 1]!);
    }
  });

  it('is empty for no attempts', () => {
    expect(backoffSchedule(0)).toEqual([]);
  });
});
