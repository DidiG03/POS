/**
 * Pure-logic tests for the per-table serialization mutex used by
 * `coreServices.setTableOpen` and the IPC handlers that touch the
 * `tables:open` / `tables:openAt` / `tables:owner` maps.
 *
 * Run with:  pnpm test
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));

import { withTableLock } from './core';

describe('withTableLock', () => {
  it('serializes concurrent calls for the same (area, label)', async () => {
    const events: string[] = [];

    const a = withTableLock('Sallon', 'T1', async () => {
      events.push('A:start');
      await new Promise((r) => setTimeout(r, 25));
      events.push('A:end');
      return 'a';
    });
    const b = withTableLock('Sallon', 'T1', async () => {
      events.push('B:start');
      await new Promise((r) => setTimeout(r, 5));
      events.push('B:end');
      return 'b';
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe('a');
    expect(rb).toBe('b');
    // B must wait for A to fully finish before its own body starts.
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('does NOT serialize calls for different tables', async () => {
    const events: string[] = [];
    const a = withTableLock('Sallon', 'T1', async () => {
      events.push('T1:start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('T1:end');
    });
    const b = withTableLock('Sallon', 'T2', async () => {
      events.push('T2:start');
      await new Promise((r) => setTimeout(r, 5));
      events.push('T2:end');
    });
    await Promise.all([a, b]);
    // T2 must finish before T1 because it's faster — proves they ran
    // in parallel, not serialised behind each other.
    expect(events.indexOf('T2:end')).toBeLessThan(events.indexOf('T1:end'));
  });

  it('releases the lock when the body throws so the next waiter can proceed', async () => {
    const calls: string[] = [];
    const failing = withTableLock('Bar', 'B1', async () => {
      calls.push('first');
      throw new Error('boom');
    }).catch((e: any) => `caught: ${e.message}`);

    const second = withTableLock('Bar', 'B1', async () => {
      calls.push('second');
      return 'ok';
    });

    const [a, b] = await Promise.all([failing, second]);
    expect(a).toBe('caught: boom');
    expect(b).toBe('ok');
    expect(calls).toEqual(['first', 'second']);
  });
});
