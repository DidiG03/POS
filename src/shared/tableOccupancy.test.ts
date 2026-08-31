import { describe, expect, it } from 'vitest';
import {
  liveOccupyingTableKeys,
  occupancyOverlapsInstant,
  reservationHasOpenTicket,
  reservationHasPaidTicket,
  reservationKeepsTableAssignment,
  tableOccupancyKey,
  ticketCoveringTableKeys,
  uncoveredOpenTickets,
  uncoveredPaidTables,
} from './tableOccupancy';

const now = Date.parse('2026-08-31T19:30:00');

const seatedT1 = {
  area: 'Main',
  tableLabel: 'T1',
  status: 'SEATED',
  startsAt: '2026-08-31T19:00:00',
  seatedAt: '2026-08-31T19:00:00',
  durationMin: 90,
};

const bookedLater = {
  area: 'Main',
  tableLabel: 'T1',
  status: 'BOOKED',
  startsAt: '2026-08-31T22:00:00',
  durationMin: 90,
};

describe('reservationKeepsTableAssignment', () => {
  it('allows editing a reservation that already holds the table', () => {
    expect(
      reservationKeepsTableAssignment(
        { area: 'Main', tableLabel: 'T1' },
        { area: 'Main', tableLabel: 'T1' },
      ),
    ).toBe(true);
  });

  it('rejects moving onto a different table', () => {
    expect(
      reservationKeepsTableAssignment(
        { area: 'Main', tableLabel: 'T1' },
        { area: 'Main', tableLabel: 'T2' },
      ),
    ).toBe(false);
    expect(
      reservationKeepsTableAssignment(null, {
        area: 'Main',
        tableLabel: 'T1',
      }),
    ).toBe(false);
  });
});

describe('uncoveredOpenTickets', () => {
  it('hides a waiter ticket that sits on an already-occupied reservation', () => {
    const live = ticketCoveringTableKeys([seatedT1], now);
    expect([...live]).toEqual([tableOccupancyKey('Main', 'T1')]);
    expect(
      uncoveredOpenTickets(
        [
          { area: 'Main', label: 'T1' },
          { area: 'Main', label: 'T8' },
        ],
        live,
      ),
    ).toEqual([{ area: 'Main', label: 'T8' }]);
  });

  it('keeps a later booking and an open ticket as two sittings', () => {
    expect(liveOccupyingTableKeys([bookedLater], now).size).toBe(1);
    const covering = ticketCoveringTableKeys([bookedLater], now);
    expect(covering.size).toBe(0);
    expect(
      uncoveredOpenTickets([{ area: 'Main', label: 'T1' }], covering),
    ).toEqual([{ area: 'Main', label: 'T1' }]);
    expect(
      reservationHasOpenTicket(
        bookedLater,
        [{ area: 'Main', label: 'T1' }],
        now,
      ),
    ).toBe(false);
  });

  it('marks the seated reservation as covering the ticket', () => {
    expect(
      reservationHasOpenTicket(seatedT1, [{ area: 'Main', label: 'T1' }], now),
    ).toBe(true);
  });

  it('treats an early arrival ticket as the same sitting as the booking', () => {
    const arrivedEarly = Date.parse('2026-08-31T18:20:00');
    const booked1900 = {
      area: 'Salla',
      tableLabel: 'T8',
      status: 'BOOKED',
      startsAt: '2026-08-31T19:00:00',
      durationMin: 90,
    };
    expect(
      reservationHasOpenTicket(
        booked1900,
        [{ area: 'Salla', label: 'T8' }],
        arrivedEarly,
      ),
    ).toBe(true);
    expect(
      uncoveredOpenTickets(
        [{ area: 'Salla', label: 'T8' }],
        ticketCoveringTableKeys([booked1900], arrivedEarly),
      ),
    ).toEqual([]);
  });

  it('does not merge a ticket opened more than two hours before the booking', () => {
    const tooEarly = Date.parse('2026-08-31T16:50:00');
    const booked1900 = {
      area: 'Salla',
      tableLabel: 'T8',
      status: 'BOOKED',
      startsAt: '2026-08-31T19:00:00',
      durationMin: 90,
    };
    expect(
      reservationHasOpenTicket(
        booked1900,
        [{ area: 'Salla', label: 'T8' }],
        tooEarly,
      ),
    ).toBe(false);
  });
});

describe('reservationHasPaidTicket', () => {
  const booked1900 = {
    area: 'Salla',
    tableLabel: 'T8',
    status: 'BOOKED',
    startsAt: '2026-08-31T19:00:00',
    durationMin: 90,
  };

  it('shows Paguar after the waiter pays that sitting', () => {
    expect(
      reservationHasPaidTicket(booked1900, [
        { area: 'Salla', label: 'T8', paidAt: '2026-08-31T20:10:00' },
      ]),
    ).toBe(true);
  });

  it('does not attach a lunch payment to the evening booking', () => {
    expect(
      reservationHasPaidTicket(booked1900, [
        { area: 'Salla', label: 'T8', paidAt: '2026-08-31T14:00:00' },
      ]),
    ).toBe(false);
  });

  it('keeps the open-ticket chip while the table is still unpaid', () => {
    expect(
      reservationHasPaidTicket(
        booked1900,
        [{ area: 'Salla', label: 'T8', paidAt: '2026-08-31T20:10:00' }],
        [{ area: 'Salla', label: 'T8' }],
      ),
    ).toBe(false);
  });

  it("does not attach this sitting's payment to the next booking", () => {
    const booked2200 = {
      id: 2,
      area: 'Salla',
      tableLabel: 'T8',
      status: 'BOOKED',
      startsAt: '2026-08-31T22:00:00',
      durationMin: 90,
    };
    const dinner = { ...booked1900, id: 1 };
    const siblings = [dinner, booked2200];
    expect(
      reservationHasPaidTicket(
        dinner,
        [{ area: 'Salla', label: 'T8', paidAt: '2026-08-31T20:10:00' }],
        [],
        siblings,
      ),
    ).toBe(true);
    expect(
      reservationHasPaidTicket(
        booked2200,
        [{ area: 'Salla', label: 'T8', paidAt: '2026-08-31T20:10:00' }],
        [],
        siblings,
      ),
    ).toBe(false);
    expect(
      reservationHasPaidTicket(
        dinner,
        [{ area: 'Salla', label: 'T8', paidAt: '2026-08-31T22:15:00' }],
        [],
        siblings,
      ),
    ).toBe(false);
  });
});

describe('occupancyOverlapsInstant', () => {
  it('blocks a walk-in while a ticket is open now', () => {
    const now = Date.parse('2026-08-31T19:30:00');
    expect(occupancyOverlapsInstant('2026-08-31T19:30:00', 90, now)).toBe(true);
  });

  it('allows a later booking on a table that is busy now', () => {
    const now = Date.parse('2026-08-31T19:30:00');
    expect(occupancyOverlapsInstant('2026-08-31T22:00:00', 90, now)).toBe(
      false,
    );
  });
});

describe('uncoveredPaidTables', () => {
  it('keeps a ticket-only payment when no reservation owns the sitting', () => {
    expect(
      uncoveredPaidTables(
        [{ area: 'Salla', label: 'T8', paidAt: '2026-08-31T20:10:00' }],
        [],
        [],
      ),
    ).toEqual([{ area: 'Salla', label: 'T8', paidAt: '2026-08-31T20:10:00' }]);
  });

  it('hides a payment that already belongs to a reservation', () => {
    const booked1900 = {
      area: 'Salla',
      tableLabel: 'T8',
      status: 'BOOKED',
      startsAt: '2026-08-31T19:00:00',
      durationMin: 90,
    };
    expect(
      uncoveredPaidTables(
        [{ area: 'Salla', label: 'T8', paidAt: '2026-08-31T20:10:00' }],
        [booked1900],
        [],
      ),
    ).toEqual([]);
  });
});
