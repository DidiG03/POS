/**
 * Fair async mutex. Waiters run in arrival order. An optional wait
 * timeout fails the waiter without releasing the holder — so a stuck
 * pay on T7 does not queue every other T7 tap forever.
 */
export type AsyncMutexWaiter = {
  grant: () => void;
  fail: (err: Error) => void;
};

export class AsyncMutex {
  private held = false;
  private readonly queue: AsyncMutexWaiter[] = [];

  async runExclusive<T>(fn: () => Promise<T>, waitMs?: number): Promise<T> {
    const release = await this.acquire(waitMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(waitMs?: number): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(() => this.unlock());
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter: AsyncMutexWaiter = {
        grant: () => {
          if (timer) clearTimeout(timer);
          resolve(() => this.unlock());
        },
        fail: reject,
      };
      this.queue.push(waiter);
      if (waitMs != null && waitMs > 0) {
        timer = setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i < 0) return;
          this.queue.splice(i, 1);
          const err = new Error('lock wait timed out');
          (err as { code?: string }).code = 'LOCK_TIMEOUT';
          reject(err);
        }, waitMs);
      }
    });
  }

  private unlock(): void {
    const next = this.queue.shift();
    if (next) {
      next.grant();
      return;
    }
    this.held = false;
  }
}

export class KeyedAsyncMutex {
  private readonly locks = new Map<string, AsyncMutex>();

  async runExclusive<T>(
    key: string,
    fn: () => Promise<T>,
    waitMs?: number,
  ): Promise<T> {
    let mutex = this.locks.get(key);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.locks.set(key, mutex);
    }
    return mutex.runExclusive(fn, waitMs);
  }
}

export function coalesceInflight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const pending = start().finally(() => {
    if (map.get(key) === pending) map.delete(key);
  });
  map.set(key, pending);
  return pending;
}
