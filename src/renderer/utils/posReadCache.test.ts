import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { invalidateCache, invalidateCachePrefix, peek } from './swrCache';
import {
  ingestFloorSnapshot,
  installPosReadCache,
  peekFloorSnapshot,
  peekLatestTicket,
  POS_CACHE,
  readFloorSnapshot,
  resetPosReadCacheForTests,
} from './posReadCache';

describe('installPosReadCache', () => {
  const prevWindow = (globalThis as any).window;

  beforeEach(() => {
    resetPosReadCacheForTests();
    invalidateCache(POS_CACHE.settings);
    invalidateCachePrefix('pos:ticket:');
    (globalThis as any).window = {};
  });

  afterEach(() => {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  });

  it('does not throw when Electron freezes window.api', () => {
    const get = async () => ({ theme: 'dark' });
    const settings = Object.freeze({ get });
    const api = Object.freeze({ settings });
    (window as any).api = api;
    expect(() => installPosReadCache()).not.toThrow();
    expect((window as any).api.settings.get).toBe(get);
  });

  it('wraps writable browser polyfill methods', async () => {
    let calls = 0;
    const api = {
      settings: {
        get: async () => {
          calls += 1;
          return { theme: 'dark' };
        },
      },
    };
    (window as any).api = api;
    installPosReadCache();
    const a = await (window as any).api.settings.get();
    const b = await (window as any).api.settings.get();
    expect(a).toEqual({ theme: 'dark' });
    expect(b).toEqual({ theme: 'dark' });
    expect(calls).toBe(1);
  });

  it('does not wrap getLatestForTable so an empty floor row cannot masquerade as the bill', () => {
    const getLatestForTable = async () => ({ items: [{ name: 'Byrek' }] });
    const api = { tickets: { getLatestForTable }, tables: {} };
    (window as any).api = api;
    installPosReadCache();
    expect(api.tickets.getLatestForTable).toBe(getLatestForTable);
  });

  it('ingests floor bills even when Electron froze getFloorSnapshot', async () => {
    const getFloorSnapshot = async () => ({
      tables: [
        {
          area: 'Salla',
          label: 'T7',
          openedAt: '2026-09-11T13:55:42.708Z',
          userId: 1,
          covers: 2,
          total: 600,
          items: [{ name: 'Sallatë cezar', qty: 1, unitPrice: 600 }],
          note: null,
        },
      ],
    });
    const tables = Object.freeze({ getFloorSnapshot });
    (window as any).api = Object.freeze({ tables });
    installPosReadCache();
    expect((window as any).api.tables.getFloorSnapshot).toBe(getFloorSnapshot);
    await readFloorSnapshot('Salla');
    expect(peekLatestTicket('Salla', 'T7')?.items?.[0]?.name).toBe(
      'Sallatë cezar',
    );
  });
});

describe('ingestFloorSnapshot', () => {
  beforeEach(() => {
    invalidateCachePrefix('pos:ticket:');
    invalidateCachePrefix('pos:floor:');
    invalidateCache(POS_CACHE.openTables);
  });

  it('does not cache an empty snapshot as the table bill', () => {
    ingestFloorSnapshot({
      tables: [
        {
          area: 'Salla',
          label: 'T7',
          openedAt: '2026-09-11T13:55:42.708Z',
          userId: 1,
          covers: 2,
          total: 0,
          items: [],
          note: null,
        },
      ],
    });
    expect(peekLatestTicket('Salla', 'T7')).toBeUndefined();
  });

  it('caches a snapshot that still has lines', () => {
    ingestFloorSnapshot(
      {
        tables: [
          {
            area: 'Salla',
            label: 'T7',
            openedAt: '2026-09-11T13:55:42.708Z',
            userId: 1,
            covers: 2,
            total: 600,
            items: [{ name: 'Sallatë cezar', qty: 1, unitPrice: 600 }],
            note: null,
          },
        ],
      },
      { area: 'Salla' },
    );
    expect(peekLatestTicket('Salla', 'T7')?.items?.[0]?.name).toBe(
      'Sallatë cezar',
    );
    expect(peekFloorSnapshot('Salla')?.tables?.[0]?.label).toBe('T7');
  });

  it('clears occupancy for an area whose snapshot has no tables', () => {
    ingestFloorSnapshot(
      {
        tables: [
          {
            area: 'Salla',
            label: 'T7',
            openedAt: '2026-09-11T13:55:42.708Z',
            userId: 1,
            covers: 2,
            total: 600,
            items: [{ name: 'Sallatë cezar', qty: 1, unitPrice: 600 }],
            note: null,
          },
        ],
      },
      { mergeOpen: true, area: 'Salla' },
    );
    ingestFloorSnapshot({ tables: [] }, { mergeOpen: true, area: 'Salla' });
    expect(peek(POS_CACHE.openTables)).toEqual([]);
    expect(peekLatestTicket('Salla', 'T7')).toBeUndefined();
  });
});
