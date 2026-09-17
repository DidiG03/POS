import { describe, expect, it, beforeEach } from 'vitest';
import {
  dedupe,
  invalidateCache,
  peek,
  swr,
  writeCache,
  clearInflight,
} from './swrCache';

describe('swrCache', () => {
  beforeEach(() => {
    invalidateCache('k');
    invalidateCache('d');
  });

  it('returns cached data without waiting on a fresh hit', async () => {
    writeCache('k', 'cached');
    let calls = 0;
    const value = await swr(
      'k',
      async () => {
        calls += 1;
        return 'fresh';
      },
      { maxAgeMs: 60_000 },
    );
    expect(value).toBe('cached');
    expect(calls).toBe(0);
    expect(peek('k')).toBe('cached');
  });

  it('serves stale data immediately while a refresh is in flight', async () => {
    writeCache('k', 'stale');
    let resolveFetch: (v: string) => void = () => undefined;
    const pending = new Promise<string>((r) => {
      resolveFetch = r;
    });
    const value = await swr('k', () => pending, { maxAgeMs: 0 });
    expect(value).toBe('stale');
    resolveFetch('fresh');
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(peek('k')).toBe('fresh');
  });

  it('waits for a stale refresh when waitIfStale is set', async () => {
    writeCache('k', 'stale');
    const value = await swr('k', async () => 'fresh', {
      maxAgeMs: 0,
      waitIfStale: true,
    });
    expect(value).toBe('fresh');
    expect(peek('k')).toBe('fresh');
  });

  it('keeps stale data when a waitIfStale refresh fails', async () => {
    writeCache('k', 'stale');
    const value = await swr(
      'k',
      async () => {
        throw new Error('offline');
      },
      { maxAgeMs: 0, waitIfStale: true },
    );
    expect(value).toBe('stale');
  });

  // A background refresh has no caller awaiting it, so its rejection used to
  // reach `window.onunhandledrejection` — and the global handler there toasts.
  // On a tablet that turned one slow LAN read into a red "Something went
  // wrong", five deep, covering the Pay button.
  it('does not leak an unhandled rejection when a background refresh fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      writeCache('k', 'stale');
      const value = await swr(
        'k',
        async () => {
          throw new TypeError('Failed to fetch');
        },
        { maxAgeMs: 0 },
      );
      expect(value).toBe('stale');
      // Let the microtask queue drain so a missing catch would have surfaced.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not leak one from the soft-revalidate path either', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      writeCache('k', 'cached');
      // Older than half of maxAgeMs but still fresh: served from cache, with a
      // refresh kicked off in the background. This is the path every 4s poll
      // of `tables.listOpen` takes.
      await new Promise((r) => setTimeout(r, 15));
      const value = await swr(
        'k',
        async () => {
          throw new TypeError('Failed to fetch');
        },
        { maxAgeMs: 20 },
      );
      expect(value).toBe('cached');
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('dedupes concurrent fetchers', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    };
    const [a, b] = await Promise.all([
      dedupe('d', fetcher),
      dedupe('d', fetcher),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it('clearInflight drops coalesced work so a new session does not reuse a 401', async () => {
    let resolveFirst: (v: string) => void = () => undefined;
    const first = new Promise<string>((r) => {
      resolveFirst = r;
    });
    const p1 = dedupe('lan:GET:/notifications:old', () => first);
    clearInflight('lan:');
    const p2 = dedupe('lan:GET:/notifications:new', async () => 'fresh');
    resolveFirst('stale-401');
    expect(await p2).toBe('fresh');
    expect(await p1).toBe('stale-401');
  });
});
