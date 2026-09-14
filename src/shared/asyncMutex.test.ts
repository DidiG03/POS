import { describe, expect, it } from 'vitest';
import { AsyncMutex, coalesceInflight, KeyedAsyncMutex } from './asyncMutex';

describe('AsyncMutex', () => {
  it('runs exclusive work in arrival order', async () => {
    const m = new AsyncMutex();
    const events: string[] = [];
    const a = m.runExclusive(async () => {
      events.push('A:start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('A:end');
      return 'a';
    });
    const b = m.runExclusive(async () => {
      events.push('B:start');
      events.push('B:end');
      return 'b';
    });
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('fails a waiter without releasing the holder', async () => {
    const m = new AsyncMutex();
    let releaseHold!: () => void;
    const hold = m.runExclusive(
      () =>
        new Promise<string>((resolve) => {
          releaseHold = () => resolve('held');
        }),
    );
    const waiting = m.runExclusive(async () => 'late', 20);
    await expect(waiting).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    releaseHold();
    await expect(hold).resolves.toBe('held');
    await expect(m.runExclusive(async () => 'next')).resolves.toBe('next');
  });
});

describe('KeyedAsyncMutex', () => {
  it('does not serialize different keys', async () => {
    const m = new KeyedAsyncMutex();
    const events: string[] = [];
    await Promise.all([
      m.runExclusive('T1', async () => {
        events.push('T1:start');
        await new Promise((r) => setTimeout(r, 20));
        events.push('T1:end');
      }),
      m.runExclusive('T2', async () => {
        events.push('T2:start');
        events.push('T2:end');
      }),
    ]);
    expect(events.indexOf('T2:end')).toBeLessThan(events.indexOf('T1:end'));
  });
});

describe('coalesceInflight', () => {
  it('shares one in-flight promise', async () => {
    const map = new Map<string, Promise<number>>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return Promise.resolve(7);
    };
    const [a, b] = await Promise.all([
      coalesceInflight(map, 'Salla', start),
      coalesceInflight(map, 'Salla', start),
    ]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(starts).toBe(1);
  });
});
