import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESERVATION_DURATION_MIN,
  effectiveReservationStatus,
  formatReservationDuration,
  isLiveReservationStatus,
  reservationOccupiesTable,
} from './reservationDuration';

describe('reservationOccupiesTable', () => {
  const now = Date.parse('2026-08-27T21:00:00');

  it('keeps a seated 90-minute walk-in occupied during the slot', () => {
    expect(
      reservationOccupiesTable(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T20:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(true);
  });

  it('frees the table when the seated duration elapses', () => {
    expect(
      reservationOccupiesTable(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T19:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(false);
  });

  it('still occupies a future booking before it starts', () => {
    expect(
      reservationOccupiesTable(
        {
          status: 'BOOKED',
          startsAt: '2026-08-27T22:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(true);
  });

  it('does not occupy completed or cancelled rows', () => {
    expect(
      reservationOccupiesTable(
        {
          status: 'COMPLETED',
          startsAt: '2026-08-27T20:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(false);
  });

  it('keeps occupying when duration was never set', () => {
    expect(
      reservationOccupiesTable(
        { status: 'SEATED', startsAt: '2026-08-27T10:00:00' },
        now,
      ),
    ).toBe(true);
  });

  it('uses each Kohëzgjatja preset as the hold length', () => {
    const start = '2026-08-27T20:00:00';
    const startMs = Date.parse(start);
    expect(
      reservationOccupiesTable(
        { status: 'SEATED', startsAt: start, durationMin: 60 },
        startMs + 59 * 60_000,
      ),
    ).toBe(true);
    expect(
      reservationOccupiesTable(
        { status: 'SEATED', startsAt: start, durationMin: 60 },
        startMs + 60 * 60_000,
      ),
    ).toBe(false);
    expect(
      reservationOccupiesTable(
        { status: 'SEATED', startsAt: start, durationMin: 180 },
        startMs + 179 * 60_000,
      ),
    ).toBe(true);
    expect(
      reservationOccupiesTable(
        { status: 'SEATED', startsAt: start, durationMin: 180 },
        startMs + 180 * 60_000,
      ),
    ).toBe(false);
  });
});

describe('formatReservationDuration', () => {
  it('labels the Kohëzgjatja chips', () => {
    expect(formatReservationDuration(60)).toBe('1h');
    expect(formatReservationDuration(90)).toBe('1:30h');
    expect(formatReservationDuration(120)).toBe('2h');
    expect(formatReservationDuration(180)).toBe('3h');
    expect(DEFAULT_RESERVATION_DURATION_MIN).toBe(90);
  });
});

describe('isLiveReservationStatus', () => {
  it('is booked or seated only', () => {
    expect(isLiveReservationStatus('BOOKED')).toBe(true);
    expect(isLiveReservationStatus('SEATED')).toBe(true);
    expect(isLiveReservationStatus('COMPLETED')).toBe(false);
  });
});

describe('effectiveReservationStatus', () => {
  const now = Date.parse('2026-08-27T21:00:00');

  it('keeps Ulur while the seated window is open', () => {
    expect(
      effectiveReservationStatus(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T20:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe('SEATED');
  });

  it('shows Përfunduar once the seated duration elapses', () => {
    expect(
      effectiveReservationStatus(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T19:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe('COMPLETED');
  });
});
