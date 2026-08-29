import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESERVATION_DURATION_MIN,
  distinctSeatedAt,
  effectiveReservationStatus,
  formatReservationClock,
  formatReservationDuration,
  isLiveReservationStatus,
  reservationOccupiesTable,
  reservationStayElapsed,
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

  it('uses the default stay when duration was never set, then frees the table', () => {
    const start = '2026-08-27T20:00:00';
    const startMs = Date.parse(start);
    expect(
      reservationOccupiesTable(
        { status: 'SEATED', startsAt: start },
        startMs + 89 * 60_000,
      ),
    ).toBe(true);
    expect(
      reservationOccupiesTable(
        { status: 'SEATED', startsAt: start },
        startMs + 90 * 60_000,
      ),
    ).toBe(false);
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

  it('holds from seated time when guests arrive late', () => {
    const now = Date.parse('2026-08-27T21:15:00');
    expect(
      reservationOccupiesTable(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T20:00:00',
          seatedAt: '2026-08-27T20:30:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(true);
    expect(
      reservationOccupiesTable(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T20:00:00',
          seatedAt: '2026-08-27T20:30:00',
          durationMin: 90,
        },
        Date.parse('2026-08-27T22:00:00'),
      ),
    ).toBe(false);
  });
});

describe('distinctSeatedAt', () => {
  it('hides seated time when it matches the booking', () => {
    expect(
      distinctSeatedAt('2026-08-27T20:00:00', '2026-08-27T20:00:30'),
    ).toBeNull();
  });

  it('returns seated time when guests arrive later', () => {
    const seated = distinctSeatedAt(
      '2026-08-27T20:00:00',
      '2026-08-27T20:30:00',
    );
    expect(seated).not.toBeNull();
    expect(formatReservationClock(seated!)).toBe('20:30');
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

  it('stays Ulur once the seated duration elapses until the host frees it', () => {
    expect(
      effectiveReservationStatus(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T19:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe('SEATED');
  });
});

describe('reservationStayElapsed', () => {
  const now = Date.parse('2026-08-27T21:00:00');

  it('is true only after a seated stay runs out', () => {
    expect(
      reservationStayElapsed(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T20:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(false);
    expect(
      reservationStayElapsed(
        {
          status: 'SEATED',
          startsAt: '2026-08-27T19:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(true);
    expect(
      reservationStayElapsed(
        {
          status: 'BOOKED',
          startsAt: '2026-08-27T19:00:00',
          durationMin: 90,
        },
        now,
      ),
    ).toBe(false);
  });
});
