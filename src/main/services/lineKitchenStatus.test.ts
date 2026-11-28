import { describe, expect, it, vi } from 'vitest';
vi.mock('@db/client', () => ({ prisma: {} }));
import { kitchenStatusFromTickets } from './lineKitchenStatus';

describe('kitchen status per line', () => {
  it('in the kitchen until bumped, by item or by station', () => {
    const r = kitchenStatusFromTickets([
      {
        itemsJson: [
          { lineId: 'a', station: 'KITCHEN' },
          { lineId: 'b', station: 'KITCHEN', bumped: true },
          { lineId: 'c', station: 'BAR' },
          { lineId: 'v', station: 'KITCHEN', voided: true },
          { name: 'no id' },
        ],
        stations: [
          { station: 'KITCHEN', status: 'NEW' },
          { station: 'BAR', status: 'DONE' },
        ],
      },
    ]);
    expect(r).toEqual({ a: 'IN_KITCHEN', b: 'DONE', c: 'DONE' });
  });

  it('a line on two cards is done only when both are', () => {
    const r = kitchenStatusFromTickets([
      { itemsJson: [{ lineId: 'a', bumped: true }], stations: [] },
      {
        itemsJson: [{ lineId: 'a' }],
        stations: [{ station: 'KITCHEN', status: 'NEW' }],
      },
    ]);
    expect(r.a).toBe('IN_KITCHEN');
  });
});
