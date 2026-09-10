import { describe, expect, it } from 'vitest';
import {
  flattenSeatGroups,
  groupLinesBySeat,
  moveLineToSeat,
  normalizeSeatName,
  seatIdForNewLine,
  seatLabel,
  seatNumber,
  shouldCloseTableAfterSeatPay,
  unpaidLinesForSeat,
  unpaidSeatIds,
} from './ticketSeats';

describe('ticketSeats', () => {
  const seats = [{ id: 's1' }, { id: 's2' }];
  const lines = [
    { id: 'a', seatId: 's1', station: 'KITCHEN' },
    { id: 'b', seatId: 's1', station: 'BAR' },
    { id: 'c', seatId: 's2', station: 'KITCHEN' },
  ];

  it('groups drinks with the seat, not in a shared bucket', () => {
    const groups = groupLinesBySeat(seats, lines);
    expect(groups.map((g) => [g.seat.id, g.lines.map((l) => l.id)])).toEqual([
      ['s1', ['a', 'b']],
      ['s2', ['c']],
    ]);
  });

  it('moves a drink onto another seat', () => {
    const next = moveLineToSeat(seats, lines, 'b', 's2', 0);
    expect(next.map((l) => [l.id, l.seatId])).toEqual([
      ['a', 's1'],
      ['b', 's2'],
      ['c', 's2'],
    ]);
  });

  it('round-trips flatten after grouping', () => {
    expect(
      flattenSeatGroups(groupLinesBySeat(seats, lines)).map((l) => l.id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('numbers seats in board order', () => {
    expect(seatNumber(seats, 's2')).toBe(2);
    expect(seatNumber(seats, 'missing')).toBeNull();
  });

  it('uses a custom name when the waiter renamed the seat', () => {
    expect(seatLabel([{ id: 's2', name: 'Anna' }], 's2', 'Seat 2')).toBe(
      'Anna',
    );
    expect(seatLabel([{ id: 's2' }], 's2', 'Seat 2')).toBe('Seat 2');
    expect(normalizeSeatName('  John  ')).toBe('John');
    expect(normalizeSeatName('   ')).toBeUndefined();
  });

  it('assigns a new line to the selected seat, not the first', () => {
    expect(
      seatIdForNewLine({
        explicit: null,
        activeSeatId: 's2',
        seats,
      }),
    ).toBe('s2');
    expect(
      seatIdForNewLine({
        explicit: undefined,
        activeSeatId: null,
        seats,
      }),
    ).toBe('s1');
  });

  it('pays one seat and keeps the table open until the last unpaid line', () => {
    const bill = [
      { id: 'a', seatId: 's1' },
      { id: 'c', seatId: 's2' },
    ];
    expect(unpaidLinesForSeat(bill, 's1').map((l) => l.id)).toEqual(['a']);
    expect(unpaidSeatIds(seats, bill)).toEqual(['s1', 's2']);
    expect(shouldCloseTableAfterSeatPay(bill, ['a'])).toBe(false);
    expect(shouldCloseTableAfterSeatPay(bill, ['a', 'c'])).toBe(true);
    expect(
      shouldCloseTableAfterSeatPay(
        [{ id: 'a', paid: true }, { id: 'c' }],
        ['c'],
      ),
    ).toBe(true);
  });
});
