import { describe, expect, it } from 'vitest';
import {
  isBlockShiftReopenEnabled,
  isShiftReopenBlocked,
  normalizeBlockShiftReopenHours,
  shiftReopenBlockedUntil,
} from './shiftReopen';

const settings = (patch: Record<string, unknown>) => ({
  preferences: patch,
});

describe('normalizeBlockShiftReopenHours', () => {
  it('accepts 2, 4, 8, 12, 24 and defaults to 12', () => {
    expect(normalizeBlockShiftReopenHours(2)).toBe(2);
    expect(normalizeBlockShiftReopenHours(4)).toBe(4);
    expect(normalizeBlockShiftReopenHours(8)).toBe(8);
    expect(normalizeBlockShiftReopenHours(12)).toBe(12);
    expect(normalizeBlockShiftReopenHours(24)).toBe(24);
    expect(normalizeBlockShiftReopenHours(99)).toBe(12);
  });
});

describe('isBlockShiftReopenEnabled', () => {
  it('requires capture clock and the nested flag', () => {
    expect(isBlockShiftReopenEnabled({})).toBe(false);
    expect(
      isBlockShiftReopenEnabled(
        settings({
          captureClockInOut: true,
          blockShiftReopen: { enabled: true },
        }),
      ),
    ).toBe(true);
    expect(
      isBlockShiftReopenEnabled(
        settings({
          captureClockInOut: false,
          blockShiftReopen: { enabled: true, hours: 12 },
        }),
      ),
    ).toBe(false);
  });
});

describe('shiftReopenBlockedUntil', () => {
  const closed = new Date('2026-09-22T10:00:00.000Z');

  it('blocks until hours after closedAt', () => {
    const until = shiftReopenBlockedUntil(
      settings({
        captureClockInOut: true,
        blockShiftReopen: { enabled: true, hours: 12 },
      }),
      closed,
      new Date('2026-09-22T15:00:00.000Z'),
    );
    expect(until?.toISOString()).toBe('2026-09-22T22:00:00.000Z');
    expect(
      isShiftReopenBlocked(
        settings({
          captureClockInOut: true,
          blockShiftReopen: { enabled: true, hours: 12 },
        }),
        closed,
        new Date('2026-09-22T15:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('allows reopen after the window', () => {
    expect(
      shiftReopenBlockedUntil(
        settings({
          captureClockInOut: true,
          blockShiftReopen: { enabled: true, hours: 12 },
        }),
        closed,
        new Date('2026-09-22T22:00:00.000Z'),
      ),
    ).toBeNull();
  });

  it('does nothing when the preference is off', () => {
    expect(
      shiftReopenBlockedUntil(
        settings({
          captureClockInOut: true,
          blockShiftReopen: { enabled: false, hours: 12 },
        }),
        closed,
        new Date('2026-09-22T11:00:00.000Z'),
      ),
    ).toBeNull();
  });
});
