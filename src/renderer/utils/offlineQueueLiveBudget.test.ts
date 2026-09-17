/**
 * A waiter must never be held hostage by a slow host.
 *
 * `tryOrQueue` tries the live call before falling back to the queue, and the
 * LAN client allows a native shell 15s per attempt plus a retry. Several UI
 * handlers await that call while holding a full-screen lock, so a host that
 * was merely slow froze the order screen for ~30s: tap a table, then watch
 * every button do nothing.
 *
 * Idempotent table-state writes therefore get a short live-attempt budget and
 * are handed to the queue when it expires. Money and kitchen chits keep the
 * full window — the waiter needs a definite live answer for those.
 *
 * These tests run in Node, where IndexedDB does not exist, so `enqueue`
 * rejects. That rejection is the observable proof that the hand-off happened:
 * the call settles on the budget instead of waiting out a dispatcher that
 * never answers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tryOrQueue } from './offlineQueue';

/** Resolves only when we say so, standing in for a host that never answers. */
function pendingForever(): Promise<never> {
  return new Promise<never>(() => {});
}

function installApi(overrides: Record<string, any>) {
  (globalThis as any).window = { api: overrides };
}

/** Let already-queued microtasks run between timer advances. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

/**
 * Settled-or-not without consuming the rejection, so a still-pending promise
 * cannot leak an unhandled rejection into a later test.
 */
function track<T>(p: Promise<T>) {
  const state = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

describe('live-attempt budget', () => {
  it('stops waiting on a hung tables.setOpen and hands it to the queue', async () => {
    installApi({ tables: { setOpen: () => pendingForever() } });

    const call = track(
      tryOrQueue('tables.setOpen', {
        area: 'Main Hall',
        label: '4',
        open: true,
      }),
    );

    // Before the budget expires we are still giving the host its chance.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(call.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(call.settled).toBe(true);
  });

  it('applies the same budget to covers.save', async () => {
    installApi({ covers: { save: () => pendingForever() } });

    const call = track(
      tryOrQueue('covers.save', { area: 'Main Hall', label: '4', covers: 2 }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(call.settled).toBe(true);
  });

  it('returns the live result untouched when the host answers in time', async () => {
    const setOpen = vi.fn(async () => ({ ok: true }));
    installApi({ tables: { setOpen } });

    const result = await tryOrQueue('tables.setOpen', {
      area: 'Main Hall',
      label: '4',
      open: false,
    });

    expect(result.queued).toBe(false);
    expect(setOpen).toHaveBeenCalledWith('Main Hall', '4', false);
  });

  it('does NOT cut short a payment — money waits for a definite answer', async () => {
    installApi({ tickets: { print: () => pendingForever() } });

    const call = track(
      tryOrQueue('payments.record', { area: 'Main Hall', tableLabel: '4' }),
    );

    // Well past the table-state budget; a sale must not be abandoned early.
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(call.settled).toBe(false);
  });
});
