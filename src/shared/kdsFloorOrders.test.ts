import { describe, expect, it } from 'vitest';
import {
  floorItemsFromTicket,
  kdsItemLiveOnStation,
  mergeKdsTicketsForFloor,
} from './kdsFloorOrders';

describe('kdsItemLiveOnStation', () => {
  it('shows kitchen lines until the kitchen KDS bumps them', () => {
    expect(kdsItemLiveOnStation({ name: 'Steak', station: 'KITCHEN' })).toBe(
      true,
    );
    expect(
      kdsItemLiveOnStation({
        name: 'Steak',
        station: 'KITCHEN',
        cookerBumped: true,
      }),
    ).toBe(true);
    expect(
      kdsItemLiveOnStation({
        name: 'Steak',
        station: 'KITCHEN',
        cookerBumped: true,
        bumped: true,
      }),
    ).toBe(false);
  });

  it('shows bar lines until the bar KDS bumps them', () => {
    expect(kdsItemLiveOnStation({ name: 'Cola', station: 'BAR' })).toBe(true);
    expect(
      kdsItemLiveOnStation({ name: 'Cola', station: 'BAR', bumped: true }),
    ).toBe(false);
  });

  it('hides voided lines', () => {
    expect(
      kdsItemLiveOnStation({
        name: 'Steak',
        station: 'KITCHEN',
        voided: true,
      }),
    ).toBe(false);
  });
});

describe('floorItemsFromTicket', () => {
  it('keeps live lines from enabled stations', () => {
    const items = floorItemsFromTicket(
      [
        { name: 'Pizza', station: 'KITCHEN', cookerBumped: true },
        { name: 'Salad', station: 'KITCHEN' },
        { name: 'Cola', station: 'BAR', bumped: true },
        { name: 'Cake', station: 'DESSERT' },
      ],
      new Set(['KITCHEN']),
    );
    expect(items.map((i) => i.name)).toEqual(['Pizza', 'Salad']);
    expect(items[0]._idx).toBe(0);
  });

  it('includes live bar lines when that station is enabled', () => {
    const items = floorItemsFromTicket(
      [
        { name: 'Pizza', station: 'KITCHEN', cookerBumped: true },
        { name: 'Cola', station: 'BAR' },
      ],
      new Set(['KITCHEN', 'BAR']),
    );
    expect(items.map((i) => i.name)).toEqual(['Pizza', 'Cola']);
  });
});

describe('mergeKdsTicketsForFloor', () => {
  it('merges kitchen and bar cards for the same ticket', () => {
    const orders = mergeKdsTicketsForFloor([
      {
        station: 'KITCHEN',
        tickets: [
          {
            ticketId: 12,
            orderNo: 4,
            area: 'Main',
            tableLabel: '12',
            waiterName: 'Ana',
            firedAt: '2026-09-06T10:00:00.000Z',
            items: [
              {
                name: 'Pizza',
                qty: 1,
                station: 'KITCHEN',
                cookerBumped: true,
              },
            ],
          },
        ],
      },
      {
        station: 'BAR',
        tickets: [
          {
            ticketId: 12,
            orderNo: 4,
            area: 'Main',
            tableLabel: '12',
            firedAt: '2026-09-06T10:01:00.000Z',
            items: [{ name: 'Cola', qty: 2 }],
          },
        ],
      },
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].items.map((i) => i.name)).toEqual(['Pizza', 'Cola']);
    expect(orders[0].items[1].station).toBe('BAR');
    expect(orders[0].firedAt).toBe('2026-09-06T10:00:00.000Z');
  });
});
