/**
 * QA round 3: the queue stayed full after the till came back, until the
 * app was killed. One replay that never settled kept `syncing` set, so
 * every later pass returned at once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_STUCK_MS,
  syncPassMayStart,
  withReplayTimeout,
} from './offlineQueue';

afterEach(() => vi.useRealTimers());

describe('offline queue recovery', () => {
  it('gives up on a replay that never settles, as a network failure', async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const p = withReplayTimeout(never, 1_000);
    const check = expect(p).rejects.toThrow(/Failed to fetch/);
    await vi.advanceTimersByTimeAsync(1_001);
    await check;
  });

  it('passes a settled replay through', async () => {
    await expect(withReplayTimeout(Promise.resolve('ok'), 1_000)).resolves.toBe(
      'ok',
    );
  });

  it('lets a new pass start once the running one is stuck', () => {
    expect(syncPassMayStart({ syncing: false, startedAt: 0, now: 10 })).toBe(
      true,
    );
    expect(syncPassMayStart({ syncing: true, startedAt: 0, now: 1_000 })).toBe(
      false,
    );
    expect(
      syncPassMayStart({ syncing: true, startedAt: 0, now: SYNC_STUCK_MS + 1 }),
    ).toBe(true);
  });
});
