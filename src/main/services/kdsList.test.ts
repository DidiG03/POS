import { describe, expect, it } from 'vitest';
import {
  buildKdsRoutingMaps,
  decorateKdsTicketItemsFromCategory,
  kdsStationsWithActiveItems,
} from './kdsStationRouting';

describe('kds category routing', () => {
  it('routes items by category kdsStation and drops unlinked categories', () => {
    const routing = buildKdsRoutingMaps(
      [
        { id: 1, kdsStation: 'KITCHEN' },
        { id: 2, kdsStation: 'BAR' },
        { id: 3, kdsStation: null },
      ],
      [
        { sku: 'pizza', categoryId: 1 },
        { sku: 'cola', categoryId: 2 },
        { sku: 'misc', categoryId: 3 },
      ],
    );
    const decorated = decorateKdsTicketItemsFromCategory(
      [
        { sku: 'pizza', name: 'Pizza', qty: 1, categoryId: 1 },
        { sku: 'cola', name: 'Cola', qty: 1, categoryId: 2 },
        { sku: 'misc', name: 'Misc', qty: 1, categoryId: 3 },
      ],
      routing,
    );
    expect(decorated.map((it) => it.name)).toEqual(['Pizza', 'Cola']);
    expect(decorated.map((it) => it.station)).toEqual(['KITCHEN', 'BAR']);
    const enabled = new Set(['KITCHEN']);
    expect(kdsStationsWithActiveItems(decorated, enabled)).toEqual(['KITCHEN']);
  });
});
