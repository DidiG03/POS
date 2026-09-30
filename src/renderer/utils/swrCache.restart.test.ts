/**
 * What a phone reads back from storage after a restart. Occupancy from the
 * last session must never come back: it painted tables red that had been
 * paid while the phone was off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'pos-swr-v2';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

async function freshCache(
  saved: Record<string, { at: number; value: unknown }>,
) {
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(saved) });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.resetModules();
  const mod = await import('./swrCache');
  return { mod, storage };
}

const HOUR = 60 * 60 * 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('swrCache after a restart', () => {
  it('never revives last session’s open tables or floor', async () => {
    const now = Date.now();
    const { mod } = await freshCache({
      'pos:open-tables': {
        at: now - HOUR,
        value: [{ area: 'Salla', label: '5' }],
      },
      'pos:floor:Salla': { at: now - HOUR, value: { tables: [] } },
      'pos:menu:v2': { at: now - HOUR, value: [{ id: 1 }] },
    });
    expect(mod.peek('pos:open-tables')).toBeUndefined();
    expect(mod.peek('pos:floor:Salla')).toBeUndefined();
    expect(mod.peek('pos:menu:v2')).toEqual([{ id: 1 }]);
  });

  it('drops a saved bill older than any sitting can be', async () => {
    const now = Date.now();
    const { mod } = await freshCache({
      'pos:ticket:Salla:5': { at: now - 13 * HOUR, value: { items: [1] } },
      'pos:ticket:Salla:6': { at: now - 10 * 60_000, value: { items: [2] } },
    });
    expect(mod.peek('pos:ticket:Salla:5')).toBeUndefined();
    expect(mod.peek('pos:ticket:Salla:6')).toEqual({ items: [2] });
  });

  it('does not write occupancy back to storage', async () => {
    const { mod, storage } = await freshCache({});
    mod.writeCache('pos:open-tables', [{ area: 'Salla', label: '5' }]);
    mod.writeCache('pos:menu:v2', [{ id: 1 }]);
    vi.advanceTimersByTime(300);
    const saved = JSON.parse(storage.data.get(STORAGE_KEY) || '{}');
    expect(Object.keys(saved)).toEqual(['pos:menu:v2']);
  });
});
