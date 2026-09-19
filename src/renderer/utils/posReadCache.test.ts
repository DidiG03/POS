import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  invalidateCache,
  invalidateCachePrefix,
  peek,
  peekAgeMs,
  writeCache,
} from './swrCache';
import {
  applyLiveTableEvent,
  cacheLatestTicket,
  ingestFloorSnapshot,
  installPosReadCache,
  peekFloorSnapshot,
  peekLatestTicket,
  peekLayout,
  POS_CACHE,
  prefetchHotReads,
  readFloorSnapshot,
  readLayout,
  resetPosReadCacheForTests,
} from './posReadCache';
import { useSessionStore } from '../stores/session';

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
    resetPosReadCacheForTests();
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

  it('occupancy poll with empty items does not wipe the ticket cache', () => {
    cacheLatestTicket('Salla', 'T7', {
      items: [{ name: 'Byrek', qty: 1, unitPrice: 1 }],
    });
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
            items: [],
            note: null,
          },
        ],
      },
      { area: 'Salla' },
    );
    expect(peekLatestTicket('Salla', 'T7')?.items?.[0]?.name).toBe('Byrek');
  });

  it('skips rewriting the same snapshot object (table-tap must not re-parse the floor)', () => {
    const snap = {
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
    };
    ingestFloorSnapshot(snap, { area: 'Salla' });
    cacheLatestTicket('Salla', 'T7', {
      items: [{ name: 'CHANGED', qty: 1, unitPrice: 1 }],
    });
    ingestFloorSnapshot(snap, { area: 'Salla' });
    expect(peekLatestTicket('Salla', 'T7')?.items?.[0]?.name).toBe('CHANGED');
  });
});

describe('readLayout', () => {
  const prevWindow = (globalThis as any).window;

  beforeEach(() => {
    resetPosReadCacheForTests();
    invalidateCachePrefix('pos:layout:');
    (globalThis as any).window = prevWindow ?? {};
  });

  afterEach(() => {
    resetPosReadCacheForTests();
    invalidateCachePrefix('pos:layout:');
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  });

  it('returns cached nodes without waiting on a hung host', async () => {
    writeCache(POS_CACHE.layout('Salla'), [{ id: 1, label: 'T1', x: 0, y: 0 }]);
    (window as any).api = {
      layout: { get: () => new Promise(() => {}) },
    };
    const nodes = await readLayout('Salla');
    expect(peekLayout('Salla')?.[0]).toMatchObject({ label: 'T1' });
    expect(nodes?.[0]).toMatchObject({ label: 'T1' });
  });
});

describe('emitPosSyncCatchupSoon', () => {
  const prevWindow = (globalThis as any).window;

  beforeEach(() => {
    resetPosReadCacheForTests();
    invalidateCache(POS_CACHE.settings);
    (globalThis as any).window = prevWindow ?? {};
  });

  afterEach(() => {
    resetPosReadCacheForTests();
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  });

  it('does not fire a second catchup within the debounce window', async () => {
    const { writeCache } = await import('./swrCache');
    const { emitPosSyncCatchupSoon } = await import('./posReadCache');
    writeCache(POS_CACHE.settings, { n: 1 });
    emitPosSyncCatchupSoon(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(peek(POS_CACHE.settings)).toBeUndefined();
    writeCache(POS_CACHE.settings, { n: 2 });
    emitPosSyncCatchupSoon(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(peek(POS_CACHE.settings)).toEqual({ n: 2 });
  });
});

describe('applyLiveTableEvent', () => {
  beforeEach(() => {
    resetPosReadCacheForTests();
    invalidateCachePrefix('pos:ticket:');
    invalidateCachePrefix('pos:floor:');
    invalidateCache(POS_CACHE.openTables);
  });

  it('keeps other tables occupancy when one waiter Sends', async () => {
    writeCache(POS_CACHE.openTables, [
      { area: 'Salla', label: 'T7' },
      { area: 'Salla', label: 'T8' },
    ]);
    writeCache(POS_CACHE.floor('Salla'), {
      tables: [
        {
          area: 'Salla',
          label: 'T7',
          openedAt: '2026-09-11T13:55:42.708Z',
          userId: 1,
          covers: 2,
          total: 600,
          items: [],
          note: null,
        },
        {
          area: 'Salla',
          label: 'T8',
          openedAt: '2026-09-11T13:55:42.708Z',
          userId: 2,
          covers: 2,
          total: 400,
          items: [],
          note: null,
        },
      ],
    });
    writeCache(POS_CACHE.ticket('Salla', 'T8'), { items: [{ name: 'keep' }] });
    await new Promise((r) => setTimeout(r, 15));
    const ageBefore = peekAgeMs(POS_CACHE.floor('Salla')) ?? 0;

    applyLiveTableEvent({ area: 'Salla', label: 'T7', userId: 9 });

    expect(peek(POS_CACHE.openTables)).toEqual([
      { area: 'Salla', label: 'T7' },
      { area: 'Salla', label: 'T8' },
    ]);
    expect(peekLatestTicket('Salla', 'T8')?.items?.[0]?.name).toBe('keep');
    expect(peekFloorSnapshot('Salla')?.tables).toEqual([
      {
        area: 'Salla',
        label: 'T7',
        openedAt: '2026-09-11T13:55:42.708Z',
        userId: 9,
        covers: 2,
        total: 600,
        items: [],
        note: null,
      },
      {
        area: 'Salla',
        label: 'T8',
        openedAt: '2026-09-11T13:55:42.708Z',
        userId: 2,
        covers: 2,
        total: 400,
        items: [],
        note: null,
      },
    ]);
    expect(peekAgeMs(POS_CACHE.floor('Salla'))).toBeGreaterThanOrEqual(
      ageBefore,
    );
  });

  it('adds and removes a single occupancy row without dropping the rest', () => {
    writeCache(POS_CACHE.openTables, [{ area: 'Salla', label: 'T8' }]);
    writeCache(POS_CACHE.floor('Salla'), {
      tables: [
        {
          area: 'Salla',
          label: 'T8',
          openedAt: '2026-09-11T13:55:42.708Z',
          userId: 2,
          covers: 2,
          total: 400,
          items: [],
          note: null,
        },
      ],
    });

    applyLiveTableEvent({
      area: 'Salla',
      label: 'T7',
      open: true,
      userId: 1,
    });
    expect(peek(POS_CACHE.openTables)).toEqual([
      { area: 'Salla', label: 'T8' },
      { area: 'Salla', label: 'T7' },
    ]);
    expect(peekFloorSnapshot('Salla')?.tables.map((t) => t.label)).toEqual([
      'T8',
      'T7',
    ]);

    applyLiveTableEvent({ area: 'Salla', label: 'T7', open: false });
    expect(peek(POS_CACHE.openTables)).toEqual([
      { area: 'Salla', label: 'T8' },
    ]);
    expect(peekFloorSnapshot('Salla')?.tables.map((t) => t.label)).toEqual([
      'T8',
    ]);
  });
});

describe('prefetchHotReads', () => {
  const prevWindow = (globalThis as any).window;

  beforeEach(() => {
    resetPosReadCacheForTests();
    useSessionStore.setState({
      user: null,
      sessionToken: null,
      expiresAtMs: null,
      authenticatedAt: 0,
    });
    (globalThis as any).window = prevWindow ?? {};
  });

  afterEach(() => {
    useSessionStore.setState({
      user: null,
      sessionToken: null,
      expiresAtMs: null,
      authenticatedAt: 0,
    });
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  });

  it('does not hit session-gated menu IPC on the PIN screen', async () => {
    let calls = 0;
    (window as any).api = {
      menu: {
        listCategoriesWithItems: async () => {
          calls += 1;
          return [];
        },
      },
    };
    prefetchHotReads();
    await Promise.resolve();
    expect(calls).toBe(0);
  });

  it('warms the menu after a signed-in session exists', async () => {
    useSessionStore.setState({
      user: { id: 1, displayName: 'Ana', role: 'WAITER' } as any,
      sessionToken: 'tok',
    });
    let calls = 0;
    (window as any).api = {
      menu: {
        listCategoriesWithItems: async () => {
          calls += 1;
          return [];
        },
      },
    };
    prefetchHotReads();
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
