import { describe, expect, it } from 'vitest';
import {
  RESERVATION_TABLE_FREE_CLASS,
  isLiveReservation,
  reservationTableColorClass,
} from './reservationFloorColor';

const booked = (
  startsAt: string,
  durationMin = 120,
): { status: string; startsAt: string; durationMin: number } => ({
  status: 'BOOKED',
  startsAt,
  durationMin,
});
const seated = (
  startsAt: string,
  durationMin = 120,
): { status: string; startsAt: string; durationMin: number } => ({
  status: 'SEATED',
  startsAt,
  durationMin,
});
const completed = (startsAt: string) => ({
  status: 'COMPLETED',
  startsAt,
  durationMin: 120,
});

describe('isLiveReservation', () => {
  it('occupies the table only while booked or seated', () => {
    expect(isLiveReservation('BOOKED')).toBe(true);
    expect(isLiveReservation('SEATED')).toBe(true);
    expect(isLiveReservation('COMPLETED')).toBe(false);
    expect(isLiveReservation('NO_SHOW')).toBe(false);
    expect(isLiveReservation('CANCELLED')).toBe(false);
  });
});

describe('reservationTableColorClass', () => {
  it('clears a finished table to grey, not green', () => {
    expect(
      reservationTableColorClass([completed('2026-08-27T19:00:00')], true),
    ).toBe(RESERVATION_TABLE_FREE_CLASS);
    expect(RESERVATION_TABLE_FREE_CLASS).toMatch(/zinc|gray/);
    expect(RESERVATION_TABLE_FREE_CLASS).not.toMatch(/emerald|green/);
  });

  it('treats an empty table the same as a completed one', () => {
    expect(reservationTableColorClass([], true)).toBe(
      RESERVATION_TABLE_FREE_CLASS,
    );
    expect(reservationTableColorClass(undefined, true)).toBe(
      RESERVATION_TABLE_FREE_CLASS,
    );
  });

  it('keeps seated tables rose and booked tables amber', () => {
    expect(
      reservationTableColorClass(
        [seated('2026-08-27T19:00:00')],
        true,
        Date.parse('2026-08-27T19:30:00'),
      ),
    ).toBe('bg-rose-700');
    expect(
      reservationTableColorClass(
        [booked('2026-08-27T23:00:00')],
        true,
        Date.parse('2026-08-27T12:00:00'),
      ),
    ).toBe('bg-amber-600');
  });

  it('marks a booking within 30 minutes as soon', () => {
    const now = Date.parse('2026-08-27T19:00:00');
    expect(
      reservationTableColorClass([booked('2026-08-27T19:20:00')], true, now),
    ).toBe('bg-blue-600');
  });

  it('frees a seated table once its duration has elapsed', () => {
    const now = Date.parse('2026-08-27T21:00:00');
    expect(
      reservationTableColorClass(
        [seated('2026-08-27T19:00:00', 90)],
        true,
        now,
      ),
    ).toBe(RESERVATION_TABLE_FREE_CLASS);
  });
});
