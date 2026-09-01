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
