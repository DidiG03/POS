import { describe, expect, it } from 'vitest';
import {
  floorThresholds,
  formatTableTimer,
  tableFloorState,
  tableIsIdle,
  tableTimerMinutes,
} from './tableState';

const now = Date.parse('2026-11-28T20:00:00Z');
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

describe('table states', () => {
  it('free, seated, ordered, served, bill requested, paid', () => {
    expect(tableFloorState({ open: false, hasItems: false }, now)).toBe('free');
    expect(
      tableFloorState({ open: true, hasItems: false, openedAt: ago(3) }, now),
    ).toBe('seated');
    expect(
      tableFloorState(
        {
          open: true,
          hasItems: true,
          kitchen: 'cooking',
          lastActionAt: ago(5),
        },
        now,
      ),
    ).toBe('ordered');
    expect(
      tableFloorState(
        { open: true, hasItems: true, kitchen: 'served', lastActionAt: ago(5) },
        now,
      ),
    ).toBe('served');
    expect(
      tableFloorState(
        {
          open: true,
          hasItems: true,
          kitchen: 'served',
          lastActionAt: ago(20),
          billPrintedAt: ago(2),
        },
        now,
      ),
    ).toBe('billRequested');
    // An order after the bill was printed: back to ordered.
    expect(
      tableFloorState(
        {
          open: true,
          hasItems: true,
          kitchen: 'cooking',
          lastActionAt: ago(1),
          billPrintedAt: ago(2),
        },
        now,
      ),
    ).toBe('ordered');
    expect(
      tableFloorState({ open: false, hasItems: false, paidAt: ago(3) }, now),
    ).toBe('paid');
    // "To clear" ends after the venue's minutes.
    expect(
      tableFloorState({ open: false, hasItems: false, paidAt: ago(11) }, now),
    ).toBe('free');
  });

  it('timer since the last action, idle past the venue limit', () => {
    const f = {
      open: true,
      hasItems: true,
      lastActionAt: ago(25),
      openedAt: ago(60),
    };
    expect(tableTimerMinutes(f, now)).toBe(25);
    expect(formatTableTimer(25)).toBe('25m');
    expect(formatTableTimer(65)).toBe('1h05');
    expect(tableIsIdle(f, now)).toBe(false);
    expect(tableIsIdle(f, now, { idleMinutes: 20, clearMinutes: 10 })).toBe(
      true,
    );
    expect(
      tableIsIdle({ open: false, hasItems: false, paidAt: ago(90) }, now),
    ).toBe(false);
  });

  it('thresholds from settings, bounded', () => {
    expect(
      floorThresholds({
        preferences: { floor: { idleMinutes: 45, clearMinutes: 5 } },
      }),
    ).toEqual({ idleMinutes: 45, clearMinutes: 5 });
    expect(
      floorThresholds({ preferences: { floor: { idleMinutes: 1 } } })
        .idleMinutes,
    ).toBe(5);
    expect(floorThresholds({})).toEqual({ idleMinutes: 30, clearMinutes: 10 });
  });
});
