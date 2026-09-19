/**
 * Tiny stale-while-revalidate cache for waiter-facing reads.
 *
 * Hits memory first, then a versioned localStorage blob so a tablet that
 * just lost Wi-Fi still has last night's menu, floor colours, and the
 * ticket the waiter was looking at. Writes stay on the durable offline
 * queue; this cache is only for reads.
 */

const STORAGE_KEY = 'pos-swr-v2';
const MAX_PERSIST_BYTES = 1_400_000;

type Entry = { at: number; value: unknown };
type Store = Record<string, Entry>;

const mem: Store = {};
const inflight = new Map<string, Promise<unknown>>();
let persistTimer: number | null = null;
let loaded = false;

function canUseStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

function load(): void {
  if (loaded) return;
  loaded = true;
  if (!canUseStorage()) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || typeof parsed !== 'object') return;
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue;
      if (typeof v.at !== 'number') continue;
      mem[k] = v;
    }
  } catch {
    // Corrupt blob — start empty rather than crash the till.
  }
}

function persistableStore(): Store {
  const out: Store = {};
  for (const [k, v] of Object.entries(mem)) {
    if (!shouldPersistCacheKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Floor occupancy is memory-only so a busy floor cannot evict the menu blob. */
export function shouldPersistCacheKey(key: string): boolean {
  return !key.startsWith('pos:floor:');
}

function schedulePersist(): void {
  if (!canUseStorage()) return;
  if (persistTimer != null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      const json = JSON.stringify(persistableStore());
      if (json.length > MAX_PERSIST_BYTES) return;
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      // Quota / private mode — memory cache still works this session.
    }
  }, 250);
}

export function peek<T>(key: string): T | undefined {
  load();
  const hit = mem[key];
  if (!hit) return undefined;
  return hit.value as T;
}

export function peekAgeMs(key: string): number | null {
  load();
  const hit = mem[key];
  if (!hit) return null;
  return Date.now() - hit.at;
}

export function writeCache<T>(key: string, value: T): void {
  load();
  mem[key] = { at: Date.now(), value };
  schedulePersist();
}

/**
 * Mutate a cached value without resetting its age. Live table events must
 * not bump `at` or a rush of Sends keeps SWR "fresh" and starves the
 * background occupancy refresh every other waiter relies on.
 */
export function patchCacheValue<T>(
  key: string,
  patch: (value: T) => T | undefined,
): boolean {
  load();
  const hit = mem[key];
  if (!hit) return false;
  const next = patch(hit.value as T);
  if (next === undefined) return false;
  hit.value = next;
  return true;
}

export function invalidateCache(key: string): void {
  load();
  delete mem[key];
  schedulePersist();
}

export function invalidateCachePrefix(prefix: string): void {
  load();
  for (const k of Object.keys(mem)) {
    if (k.startsWith(prefix)) delete mem[k];
  }
  schedulePersist();
}

/**
 * Return cached data immediately when we have it, and refresh in the
 * background once it is older than `maxAgeMs`. First load with no cache
 * waits for the network.
 */
export async function swr<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: { maxAgeMs?: number; waitIfStale?: boolean },
): Promise<T> {
  load();
  const maxAgeMs = opts?.maxAgeMs ?? 10_000;
  const hit = mem[key];
  const age = hit ? Date.now() - hit.at : Infinity;
  const existing = inflight.get(key) as Promise<T> | undefined;

  const revalidate = (): Promise<T> => {
    if (existing) return existing;
    const p = fetcher()
      .then((value) => {
        writeCache(key, value);
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  };

  // Nobody is waiting on a background refresh, so its rejection would reach
  // `window.onunhandledrejection` and the global handler would toast it. On a
  // tablet that turns one slow LAN read into a red "Something went wrong" —
  // for data the caller already served from cache.
  const revalidateInBackground = (): void => {
    revalidate().catch(() => undefined);
  };

  if (hit && age < maxAgeMs) {
    if (age > maxAgeMs / 2 && !existing) revalidateInBackground();
    return hit.value as T;
  }
  if (hit) {
    if (opts?.waitIfStale) {
      try {
        return await revalidate();
      } catch {
        return hit.value as T;
      }
    }
    revalidateInBackground();
    return hit.value as T;
  }
  return revalidate();
}

/** Coalesce concurrent identical work without persisting the result. */
export function dedupe<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fetcher().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/**
 * Drop coalesced in-flight LAN reads. Call this on a fresh PIN login so a
 * 401 that is still in flight from the previous session cannot be reused
 * as the result of the new session's first GET.
 */
export function clearInflight(prefix?: string): void {
  if (!prefix) {
    inflight.clear();
    return;
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}
