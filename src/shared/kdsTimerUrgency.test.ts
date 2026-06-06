import { describe, expect, it } from 'vitest';
import {
  kdsElapsedSeconds,
  kdsTimerUrgencyFromElapsed,
  kdsTimerUrgencyFromIso,
} from './kdsTimerUrgency';

describe('kdsTimerUrgency', () => {
  const fired = '2026-05-26T12:00:00.000Z';

  it('computes elapsed seconds', () => {
    const now = new Date(fired).getTime() + 125_000;
    expect(kdsElapsedSeconds(fired, now)).toBe(125);
  });

  it('returns fresh under warning threshold', () => {
    expect(kdsTimerUrgencyFromElapsed(9 * 60)).toBe('fresh');
  });

  it('returns warning between thresholds', () => {
    expect(kdsTimerUrgencyFromElapsed(10 * 60)).toBe('warning');
    expect(kdsTimerUrgencyFromElapsed(19 * 60 + 59)).toBe('warning');
  });

  it('returns late at or above late threshold', () => {
    expect(kdsTimerUrgencyFromElapsed(20 * 60)).toBe('late');
    expect(kdsTimerUrgencyFromElapsed(90 * 60)).toBe('late');
  });

  it('derives urgency from ISO firedAt', () => {
    const now = new Date(fired).getTime() + 25 * 60 * 1000;
    expect(kdsTimerUrgencyFromIso(fired, now)).toBe('late');
  });

  it('returns null for invalid ISO', () => {
    expect(kdsTimerUrgencyFromIso('not-a-date')).toBeNull();
  });
});
