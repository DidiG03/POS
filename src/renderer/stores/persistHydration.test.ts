import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(seed: Record<string, unknown> = {}): Storage {
  const data = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

// localStorage hydrates inside create(); a callback that reaches for the
// store binding there throws and leaves hasHydrated false forever.
describe('persisted stores finish hydrating', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ticket store is ready and keeps the persisted binding', async () => {
    vi.stubGlobal(
      'localStorage',
      memoryStorage({
        'pos-ticket': {
          version: 2,
          state: {
            lines: [{ id: 'a', name: 'Soup', qty: 1, unitPrice: 5 }],
            courses: [],
            seats: [],
            activeCourseId: null,
            activeSeatId: null,
            orderNote: '',
            addMode: 'default',
            boundKey: 'Main:T1',
            savedAt: Date.now(),
            drafts: {},
          },
        },
      }),
    );
    const { useTicketStore } = await import('./ticket');
    expect(useTicketStore.persist.hasHydrated()).toBe(true);
    expect(useTicketStore.getState().hasHydrated).toBe(true);
    expect(useTicketStore.getState().boundKey).toBe('Main:T1');
    expect(useTicketStore.getState().lines).toHaveLength(1);
  });

  it('ticket store is ready with nothing persisted', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { useTicketStore } = await import('./ticket');
    expect(useTicketStore.getState().hasHydrated).toBe(true);
  });

  it('ticket store is ready even when the persisted blob is corrupt', async () => {
    const storage = memoryStorage();
    storage.setItem('pos-ticket', '{not json');
    vi.stubGlobal('localStorage', storage);
    const { useTicketStore } = await import('./ticket');
    await Promise.resolve();
    expect(useTicketStore.getState().hasHydrated).toBe(true);
  });

  it('table status drops optimistic occupancy from the last run', async () => {
    vi.stubGlobal(
      'localStorage',
      memoryStorage({
        'pos-table-status': {
          version: 1,
          state: {
            openMap: { 'Main:T1': true },
            lastSetAt: { 'Main:T1': Date.now() },
          },
        },
      }),
    );
    const { useTableStatus } = await import('./tableStatus');
    expect(useTableStatus.persist.hasHydrated()).toBe(true);
    expect(useTableStatus.getState().openMap).toEqual({});
    expect(useTableStatus.getState().lastSetAt).toEqual({});
  });

  it('session store is ready without waiting for a timer', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { useSessionStore } = await import('./session');
    expect(useSessionStore.persist.hasHydrated()).toBe(true);
    expect(useSessionStore.getState().hasHydrated).toBe(true);
  });

  it('session store is ready even when the persisted blob is corrupt', async () => {
    const storage = memoryStorage();
    storage.setItem('pos-session', '{not json');
    vi.stubGlobal('localStorage', storage);
    const { useSessionStore } = await import('./session');
    await Promise.resolve();
    expect(useSessionStore.getState().hasHydrated).toBe(true);
  });
});
