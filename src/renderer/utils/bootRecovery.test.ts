/** QA v0.2.103: the phone recovers from "Cannot reach POS backend" by itself. */
import { describe, expect, it, vi } from 'vitest';
import { bootRetryDelayMs, watchForBackend } from './bootRecovery';

describe('bootRetryDelayMs', () => {
  it('backs off 2, 4, 8 s, then holds at 15 s', () => {
    expect([0, 1, 2, 3, 4, 50].map(bootRetryDelayMs)).toEqual([
      2000, 4000, 8000, 15000, 15000, 15000,
    ]);
  });
});

describe('watchForBackend', () => {
  it('keeps trying while the till is down and boots once when it answers', async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const probe = vi.fn(async () => {
        if (!up) throw new Error('unreachable');
        return {};
      });
      const onBack = vi.fn();
      watchForBackend({ probe, onBack });
      await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(onBack).not.toHaveBeenCalled();
      up = true; // the till is back
      await vi.advanceTimersByTimeAsync(15000);
      expect(onBack).toHaveBeenCalledTimes(1);
      // ...and stops probing after that.
      await vi.advanceTimersByTimeAsync(60000);
      expect(probe).toHaveBeenCalledTimes(4);
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries at once when the phone comes back online or to the foreground', async () => {
    vi.useFakeTimers();
    try {
      let wake: () => void = () => {};
      const onBack = vi.fn();
      watchForBackend({
        probe: async () => ({}),
        onBack,
        subscribeWake: (w) => {
          wake = w;
          return () => {};
        },
      });
      wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops cleanly when the screen goes away', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => {
        throw new Error('down');
      });
      const unsubscribe = vi.fn();
      const stop = watchForBackend({
        probe,
        onBack: () => {},
        subscribeWake: () => unsubscribe,
      });
      stop();
      await vi.advanceTimersByTimeAsync(60000);
      expect(probe).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
