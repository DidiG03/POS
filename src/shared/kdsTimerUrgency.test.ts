import { describe, expect, it } from 'vitest';
import {
  kdsElapsedSeconds,
  kdsTimerUrgencyFromElapsed,
  kdsTimerUrgencyFromIso,
  oldestWaitingFiredAt,
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

describe('oldestWaitingFiredAt', () => {
  const card = '2026-10-31T12:00:00.000Z';
  const later = '2026-10-31T12:25:00.000Z';

  it('a card whose early lines are done times the line sent later', () => {
    expect(
      oldestWaitingFiredAt(
        [
          { name: 'Soup', bumped: true },
          { name: 'Fries', kdsFiredAt: later },
        ],
        card,
        { cooker: false },
      ),
    ).toBe(later);
  });

  it('a line still waiting from the first Send keeps the card age', () => {
    expect(
      oldestWaitingFiredAt(
        [{ name: 'Soup' }, { name: 'Fries', kdsFiredAt: later }],
        card,
        { cooker: false },
      ),
    ).toBe(card);
  });

  it('on the cooker screen, cooked lines no longer count', () => {
    expect(
      oldestWaitingFiredAt(
        [
          { name: 'Soup', cookerBumped: true },
          { name: 'Fries', kdsFiredAt: later },
        ],
        card,
        { cooker: true },
      ),
    ).toBe(later);
  });

  it('nothing waiting: the card time', () => {
    expect(
      oldestWaitingFiredAt([{ name: 'Soup', voided: true }], card, {
        cooker: false,
      }),
    ).toBe(card);
  });
});
