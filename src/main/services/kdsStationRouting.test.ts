import { describe, expect, it } from 'vitest';
import {
  ALL_KDS_STATIONS,
  decorateKdsTicketItemsFromCategory,
  enabledStationsFromSettings,
  kdsStationsWithActiveItems,
} from './kdsStationRouting';

describe('enabledStationsFromSettings', () => {
  it('enables every station when no setting is present', () => {
    const set = enabledStationsFromSettings(undefined);
    expect([...set].sort()).toEqual([...ALL_KDS_STATIONS].sort());
  });

  it('enables every station when the kds map is empty', () => {
    const set = enabledStationsFromSettings({ kds: { stations: {} } });
    expect([...set].sort()).toEqual([...ALL_KDS_STATIONS].sort());
  });

  it('only treats an explicit false as disabled', () => {
    const set = enabledStationsFromSettings({
      kds: { stations: { BAR: false, KITCHEN: true } },
    });
    expect(set.has('KITCHEN')).toBe(true);
    expect(set.has('DESSERT')).toBe(true);
    expect(set.has('BAR')).toBe(false);
  });

  it('returns no stations when the master KDS switch is off', () => {
    const set = enabledStationsFromSettings({
      kds: { enabled: false, stations: { KITCHEN: true, BAR: true } },
    });
    expect(set.size).toBe(0);
  });
});

describe('disabled stations stop routing', () => {
  const routing = {
    categoryIdToKdsStation: { 1: 'KITCHEN', 2: 'BAR' },
    skuToKdsStation: {},
  };

  it('drops a disabled station from the fan-out', () => {
    const decorated = decorateKdsTicketItemsFromCategory(
      [
        { name: 'Steak', categoryId: 1 },
        { name: 'Coke', categoryId: 2 },
      ],
      routing,
    );
    const enabled = enabledStationsFromSettings({
      kds: { stations: { BAR: false } },
    });
    const used = kdsStationsWithActiveItems(decorated, enabled);
    expect(used).toEqual(['KITCHEN']);
  });
});
