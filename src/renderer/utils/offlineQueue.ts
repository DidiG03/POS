/**
 * Renderer-side offline queue.
 *
 * Originally this only protected order creation (`tickets.log`). PR 4a
 * generalises it: any waiter action that talks to the main process or
 * the cloud — payments, voids, table state changes, covers updates —
 * can be wrapped with `tryOrQueue()` and gain the same offline safety
 * net.
 *
 * Storage:
 *   - IndexedDB database `pos-offline`, single object store `orders`.
 *   - We did NOT bump the schema version: the legacy
 *     `OfflineItem = { id, payload }` records still live in the same
 *     store and are replayed lazily as `tickets.log` composite ops.
 *
 * Reliability:
 *   - Per-item exponential backoff with jitter (≤30 s wait between
 *     attempts), capped at 12 attempts (~5 min total wall time).
 *   - "Latest wins" deduplication via `dedupeKey` — so a waiter who
 *     mashes the close-table button doesn't queue 8 separate writes.
 *   - On a network-shaped error we stop draining the queue early to
 *     avoid pointlessly hammering an offline server.
 *   - Bounded at 500 items; oldest are dropped if the cap is hit.
 *
 * Observability (for PR 4b's sync-status badge):
 *   - Every queue mutation dispatches a `'offline-queue:changed'`
 *     CustomEvent with `{ pending }` so a top-bar badge can subscribe
 *     without polling.
 */

export type OfflineOp =
  | 'tickets.log'
  | 'tickets.voidItem'
  | 'tickets.voidTicket'
  | 'tables.setOpen'
  | 'tables.transfer'
  | 'covers.save'
  | 'payments.record';

export interface OfflineQueueItem {
  id: string;
  op: OfflineOp;
  args: any;
  attempts: number;
  nextAttemptAt: number; // epoch ms
  lastError?: string;
  dedupeKey?: string;
  createdAt: number;
}

/** Legacy shape from before PR 4a — items written by older app versions. */
interface LegacyOfflineItem {
  id: string;
  payload: any;
}

const DB_NAME = 'pos-offline';
const STORE = 'orders';
/** Items that exceeded MAX_ATTEMPTS or were permanently rejected live here. */
const FAILED_STORE = 'failed';
const DB_VERSION = 2;
const MAX_ITEMS = 500;
const MAX_ATTEMPTS = 12;
const QUEUE_CHANGE_EVENT = 'offline-queue:changed';
const FAILED_CHANGE_EVENT = 'offline-queue:failed-changed';

/**
 * Operations that move money or create the source-of-truth order. These
 * must NEVER be silently dropped: a transient outage longer than the
 * retry budget keeps retrying forever (at the capped backoff) instead of
 * discarding the write. Only a PERMANENT server rejection moves them to
 * the failed surface for manual review.
 */
const MONEY_OPS = new Set<OfflineOp>(['tickets.log', 'payments.record']);

/** Why an item ended up on the failed surface. */
export type FailedReason = 'rejected' | 'exhausted';

export interface FailedSyncItem extends OfflineQueueItem {
  failedAt: number;
  reason: FailedReason;
}

function isNativeCapacitor(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as any).Capacitor;
  return (
    Boolean(capacitor?.isNativePlatform?.()) ||
    Boolean(capacitor?.getPlatform?.() && capacitor.getPlatform() !== 'web')
  );
}

/** Map every error we want to forgive (i.e. "try again later"). */
function isLikelyOfflineError(e: any): boolean {
  if (!e) return false;
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.cause?.code || e?.code || '').toLowerCase();
  if (
    code.includes('enotfound') ||
    code.includes('econnrefused') ||
    code.includes('etimedout') ||
    code.includes('econnreset') ||
    code.includes('ehostunreach') ||
    code.includes('enetunreach')
  ) {
    return true;
  }
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('network')) return true;
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('timed out') || msg.includes('timeout')) return true;
  if (msg.includes('failed to fetch')) return true;
  // Vite/Electron preload occasionally surfaces a "renderer not ready"
  // style transport error during boot — treat as transient.
  if (msg.includes('disconnected port')) return true;
  return false;
}

function jitter(ms: number): number {
  return Math.floor(ms * (0.8 + Math.random() * 0.4));
}

function computeBackoffMs(attempts: number): number {
  // 1s, 2s, 4s, 8s, 16s, 30s (cap), 30s, …
  return jitter(Math.min(30_000, 1000 * Math.pow(2, Math.min(8, attempts))));
}

/**
 * Per-op dispatchers. These are the SAME calls the renderer would make
 * when online — kept thin so the queue never "knows" anything special
 * about each op.
 */
const dispatchers: Record<OfflineOp, (args: any) => Promise<void>> = {
  // The legacy composite: open the table FIRST so `openAt` exists
  // before the ticket / covers writes. Nested catches make the
  // sidecars best-effort — if covers.save fails we still consider the
  // ticket logged successfully (covers are advisory, the ticket is
  // money).
  'tickets.log': async (a) => {
    if (a?.area && a?.tableLabel) {
      try {
        await window.api.tables.setOpen(
          String(a.area),
          String(a.tableLabel),
          true,
        );
      } catch {
        // ignore — the ticket itself is the source of truth
      }
    }
    // Server now returns a richer `{ ok, error?, code? }` object. Old
    // callers (legacy queue items) might have hit the boolean version
    // — treat both shapes as success unless the new `ok: false` signal
    // arrives, in which case throw a tagged error so callers can react
    // (and so the queue can drop permanently-rejected items instead of
    // retrying them forever).
    const result: any = await window.api.tickets.log(a);
    if (result && typeof result === 'object' && result.ok === false) {
      const err: any = new Error(
        String(result.error || 'Ticket rejected by server'),
      );
      err.code = String(result.code || 'TICKET_REJECTED');
      err.permanent = true;
      throw err;
    }
    if (a?.area && a?.tableLabel) {
      const c = Number(a?.covers);
      if (Number.isFinite(c) && c > 0) {
        try {
          await window.api.covers.save(String(a.area), String(a.tableLabel), c);
        } catch {
          // ignore — secondary
        }
      }
    }
  },

  'tickets.voidItem': async (a) => {
    await window.api.tickets.voidItem(a);
  },

  'tickets.voidTicket': async (a) => {
    await window.api.tickets.voidTicket(a);
  },

  'tables.setOpen': async (a) => {
    await window.api.tables.setOpen(
      String(a.area),
      String(a.label),
      Boolean(a.open),
    );
  },

  'tables.transfer': async (a) => {
    if (!window.api.tables?.transfer) {
      throw new Error('Table transfer is unavailable');
    }
    const r: any = await window.api.tables.transfer(a);
    if (r && typeof r === 'object' && r.ok === false) {
      const err: any = new Error(
        String(r.error || 'Transfer rejected by server'),
      );
      err.code = String(r.code || 'TRANSFER_REJECTED');
      err.permanent = true;
      throw err;
    }
    return r;
  },

  'covers.save': async (a) => {
    await window.api.covers.save(
      String(a.area),
      String(a.label),
      Number(a.covers),
    );
  },

  'payments.record': async (a) => {
    // `idempotencyKey` is forwarded to `tickets.print`; the IPC handler
    // dedupes identical keys so offline-queue retries cannot double-record
    // a payment audit row (PrintJob).
    await window.api.tickets.print(a);
  },
};

class OfflineQueue {
  private dbPromise: Promise<IDBDatabase>;
  private onlineHandler: (() => void) | null = null;
  private startupTimer: number | null = null;
  private syncing = false;
  // Serialises store read-modify-write critical sections (enqueue, the
  // commit phase of sync, retryFailed) so two writers can't clobber each
  // other's changes. Network I/O deliberately runs OUTSIDE this lock.
  private opLock: Promise<unknown> = Promise.resolve();

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
        // v2: durable "needs attention" store for permanently-rejected
        // and exhausted (non-money) operations.
        if (!db.objectStoreNames.contains(FAILED_STORE)) {
          db.createObjectStore(FAILED_STORE, { keyPath: 'id' });
        }
      };
      // Another tab/window is holding an older version open and blocking
      // our upgrade. We can't force it; the open will proceed once they
      // close. Surface it instead of hanging silently in dev.
      req.onblocked = () => {
        try {
          console.warn(
            '[offlineQueue] IndexedDB upgrade blocked by another open connection; waiting for it to close.',
          );
        } catch {
          // ignore
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // If a FUTURE version wants to upgrade, close this connection so
        // we never block the other tab (and never leave a half-open DB).
        try {
          db.onversionchange = () => {
            try {
              db.close();
            } catch {
              // ignore
            }
          };
        } catch {
          // ignore
        }
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });

    if (typeof window !== 'undefined') {
      // Stable handler so we can remove it cleanly under HMR.
      this.onlineHandler = () => void this.sync();
      window.addEventListener('online', this.onlineHandler);
      // Best-effort flush a moment after boot — covers the case where
      // we were online when the user reopened the app and there's
      // backlog from a previous session.
      this.startupTimer = window.setTimeout(() => void this.sync(), 800);
    }
  }

  dispose() {
    if (typeof window === 'undefined') return;
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    if (this.startupTimer) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  /**
   * Run a store mutation exclusively. Chains onto the previous op so the
   * read-modify-write sequences inside never interleave. Errors in one
   * op don't break the chain for the next.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.opLock.then(fn, fn);
    this.opLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---- public API -------------------------------------------------

  async enqueue(
    op: OfflineOp,
    args: any,
    options?: { dedupeKey?: string },
  ): Promise<{ pending: number }> {
    return this.withLock(async () => {
      const all = await this.getAll();
      const next: OfflineQueueItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        op,
        args,
        attempts: 0,
        nextAttemptAt: 0,
        dedupeKey: options?.dedupeKey,
        createdAt: Date.now(),
      };

      let items: OfflineQueueItem[] = all
        .map(this.normalize)
        .filter((it): it is OfflineQueueItem => it !== null);

      // Latest-wins coalescing: drop older entries with the same dedupe
      // key. Keeps a quick "open / close / open" sequence to ONE final
      // write instead of three.
      if (next.dedupeKey) {
        items = items.filter((it) => it.dedupeKey !== next.dedupeKey);
      }
      items.push(next);

      // Bound: drop oldest beyond the cap. Anything past 500 means the
      // user has been offline for a very long time AND keeps mashing
      // buttons; the alternative is unbounded IDB growth which can OOM
      // a Safari tab.
      if (items.length > MAX_ITEMS) {
        items = items.slice(items.length - MAX_ITEMS);
      }

      await this.replaceAll(items);
      this.broadcastChange(items.length);
      return { pending: items.length };
    });
  }

  async getPendingCount(): Promise<number> {
    const items = await this.getAll();
    return items.length;
  }

  async sync(): Promise<{ sent: number; remaining: number }> {
    if (this.syncing)
      return { sent: 0, remaining: await this.getPendingCount() };
    if (
      typeof navigator !== 'undefined' &&
      !navigator.onLine &&
      !isNativeCapacitor()
    ) {
      return { sent: 0, remaining: await this.getPendingCount() };
    }

    this.syncing = true;
    let sent = 0;
    try {
      const raw = await this.getAll();
      const items: OfflineQueueItem[] = raw
        .map(this.normalize)
        .filter((it): it is OfflineQueueItem => it !== null);

      const now = Date.now();
      // We never mutate the store mid-loop (a concurrent enqueue/retry
      // could be clobbered). Instead we record decisions and apply them
      // atomically in `commitSync`, which re-reads under the lock and
      // preserves any items added while the network calls were in flight.
      const removedIds = new Set<string>();
      const updates = new Map<
        string,
        { attempts: number; nextAttemptAt: number; lastError?: string }
      >();
      let touched = false;

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.nextAttemptAt && it.nextAttemptAt > now) continue;

        const dispatcher = dispatchers[it.op];
        if (!dispatcher) {
          // Unknown opcode — drop it rather than poison the queue.
          // This can happen if a feature is rolled back or the user
          // downgrades the app; better to lose one stale operation
          // than to block every newer item behind it.
          removedIds.add(it.id);
          touched = true;
          continue;
        }

        try {
          // Stable idempotency key derived from the queue item id —
          // safe to retry the same enqueue forever without
          // double-processing on the main side (provided the IPC
          // honours it; tickets.log already does).
          const args = { ...it.args, idempotencyKey: it.id };
          await dispatcher(args);
          removedIds.add(it.id);
          sent += 1;
          touched = true;
        } catch (e: any) {
          // Permanent server rejections (e.g. table is now closed,
          // table owned by another waiter, validation failure) will
          // never succeed on a retry. Drop them immediately and tell
          // the UI so the waiter sees a toast instead of a silent loss.
          if (e?.permanent === true) {
            const failedItem: OfflineQueueItem = {
              ...it,
              lastError: String(e?.message || e || 'rejected'),
            };
            this.broadcastDrop(failedItem);
            // Permanent rejections (table closed, owned by another waiter,
            // validation) will never succeed — move to the durable failed
            // surface so an operator can see exactly what was lost.
            await this.recordFailed(failedItem, 'rejected');
            removedIds.add(it.id);
            touched = true;
            continue;
          }
          const attempts = Math.min(MAX_ATTEMPTS, (it.attempts || 0) + 1);
          const lastError = String(e?.message || e || 'request failed');
          if (attempts >= MAX_ATTEMPTS) {
            if (MONEY_OPS.has(it.op)) {
              // NEVER drop an order/payment. The server is the source of
              // truth for money; keep retrying at the capped backoff
              // (~30s) until it lands. The UI surfaces it as "stuck" so
              // staff know a write hasn't synced yet.
              updates.set(it.id, {
                attempts,
                nextAttemptAt: Date.now() + computeBackoffMs(attempts),
                lastError,
              });
            } else {
              // Non-money op (e.g. covers, table colour) retried for ~5 min
              // of wall time. Move it to the failed surface for review
              // instead of silently discarding it.
              const failedItem: OfflineQueueItem = {
                ...it,
                attempts,
                lastError,
              };
              this.broadcastDrop(failedItem);
              await this.recordFailed(failedItem, 'exhausted');
              removedIds.add(it.id);
            }
          } else {
            updates.set(it.id, {
              attempts,
              nextAttemptAt: Date.now() + computeBackoffMs(attempts),
              lastError,
            });
          }
          touched = true;
          // If the box clearly can't reach the network, don't burn
          // through every other queued item making the same failed
          // call — wait for the next 'online' event.
          if (isLikelyOfflineError(e)) break;
        }
      }

      let remaining = items.length;
      if (touched) {
        remaining = await this.commitSync(removedIds, updates);
      }
      return { sent, remaining };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Apply a sync pass's decisions atomically. Re-reads the live store
   * under the lock so that items added by a concurrent `enqueue` /
   * `retryFailed` (ids the sync pass never saw) are preserved instead of
   * being clobbered by a stale snapshot.
   */
  private async commitSync(
    removedIds: Set<string>,
    updates: Map<
      string,
      { attempts: number; nextAttemptAt: number; lastError?: string }
    >,
  ): Promise<number> {
    return this.withLock(async () => {
      const current = (await this.getAll())
        .map(this.normalize)
        .filter((it): it is OfflineQueueItem => it !== null);
      const next: OfflineQueueItem[] = [];
      for (const row of current) {
        if (removedIds.has(row.id)) continue;
        const u = updates.get(row.id);
        if (u) {
          row.attempts = u.attempts;
          row.nextAttemptAt = u.nextAttemptAt;
          row.lastError = u.lastError;
        }
        next.push(row);
      }
      await this.replaceAll(next);
      this.broadcastChange(next.length);
      return next.length;
    });
  }

  // ---- internals --------------------------------------------------

  /** Treat a row pulled from IDB (which may be the v1 legacy shape) as the v2 shape. */
  private normalize(row: any): OfflineQueueItem | null {
    if (!row || typeof row !== 'object' || !row.id) return null;
    if (row.op && row.args) {
      return {
        id: String(row.id),
        op: row.op as OfflineOp,
        args: row.args,
        attempts: Number(row.attempts || 0),
        nextAttemptAt: Number(row.nextAttemptAt || 0),
        lastError: row.lastError ? String(row.lastError) : undefined,
        dedupeKey: row.dedupeKey ? String(row.dedupeKey) : undefined,
        createdAt: Number(row.createdAt || Date.now()),
      };
    }
    // Backward compat: pre-PR-4a items only had `{ id, payload }` and
    // were always tickets.log composites. Re-hydrate them into the new
    // shape so the rest of the loop is uniform.
    const legacy = row as LegacyOfflineItem;
    if (legacy.payload) {
      return {
        id: String(legacy.id),
        op: 'tickets.log',
        args: legacy.payload,
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: Date.now(),
      };
    }
    return null;
  }

  private async getAll(): Promise<any[]> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as any[]) || []);
      req.onerror = () => reject(req.error);
    });
  }

  /** Atomic-from-IDB-perspective full replacement: clear + bulk insert in one tx. */
  private async replaceAll(items: OfflineQueueItem[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const it of items) store.put(it);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private broadcastChange(pending: number) {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(
        new CustomEvent(QUEUE_CHANGE_EVENT, { detail: { pending } }),
      );
    } catch {
      // Old browsers — not a deal-breaker, the queue still works.
    }
  }

  private broadcastDrop(it: OfflineQueueItem) {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(
        new CustomEvent('offline-queue:dropped', {
          detail: {
            id: it.id,
            op: it.op,
            attempts: it.attempts,
            lastError: it.lastError,
          },
        }),
      );
    } catch {
      // ignore
    }
  }

  // ---- failed surface (PR #6) -------------------------------------

  /** Persist an item that can no longer be replayed automatically. */
  private async recordFailed(
    it: OfflineQueueItem,
    reason: FailedReason,
  ): Promise<void> {
    try {
      const db = await this.dbPromise;
      const tx = db.transaction(FAILED_STORE, 'readwrite');
      const failed: FailedSyncItem = { ...it, failedAt: Date.now(), reason };
      tx.objectStore(FAILED_STORE).put(failed);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      this.broadcastFailedChange(await this.getFailedCount());
    } catch {
      // The failed surface is advisory — never let a bookkeeping write
      // break the live queue.
    }
  }

  async getFailed(): Promise<FailedSyncItem[]> {
    try {
      const db = await this.dbPromise;
      const tx = db.transaction(FAILED_STORE, 'readonly');
      const req = tx.objectStore(FAILED_STORE).getAll();
      const rows: any[] = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve((req.result as any[]) || []);
        req.onerror = () => reject(req.error);
      });
      return rows
        .filter((r) => r && r.id && r.op)
        .sort((a, b) => Number(b.failedAt || 0) - Number(a.failedAt || 0));
    } catch {
      return [];
    }
  }

  async getFailedCount(): Promise<number> {
    return (await this.getFailed()).length;
  }

  private async deleteFailed(id: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(FAILED_STORE, 'readwrite');
    tx.objectStore(FAILED_STORE).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Move a failed item back into the live queue and try again now. */
  async retryFailed(id: string): Promise<{ requeued: boolean }> {
    const failed = await this.getFailed();
    const row = failed.find((f) => f.id === id);
    if (!row) return { requeued: false };
    const revived: OfflineQueueItem = {
      id: row.id,
      op: row.op,
      args: row.args,
      attempts: 0,
      nextAttemptAt: 0,
      dedupeKey: row.dedupeKey,
      createdAt: row.createdAt || Date.now(),
    };
    await this.withLock(async () => {
      const all = (await this.getAll())
        .map(this.normalize)
        .filter((it): it is OfflineQueueItem => it !== null)
        .filter((it) => it.id !== revived.id);
      all.push(revived);
      await this.replaceAll(all);
      this.broadcastChange(all.length);
    });
    // Only drop the failed-store copy once the live re-queue is durable.
    // If we crash between these two writes the item is briefly in BOTH
    // stores (it will sync from the live queue and can be dismissed from
    // the banner) — never in NEITHER, so it can't be lost.
    await this.deleteFailed(id);
    this.broadcastFailedChange(await this.getFailedCount());
    void this.sync();
    return { requeued: true };
  }

  /** Permanently discard a failed item (operator acknowledged the loss). */
  async dismissFailed(id: string): Promise<void> {
    await this.deleteFailed(id);
    this.broadcastFailedChange(await this.getFailedCount());
  }

  private broadcastFailedChange(count: number) {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(
        new CustomEvent(FAILED_CHANGE_EVENT, { detail: { count } }),
      );
    } catch {
      // ignore
    }
  }
}

function getGlobalOfflineQueue(): OfflineQueue {
  // Stash on `window` so the queue survives Vite HMR — otherwise dev
  // sessions accumulate one new IDB connection per save.
  const g: any =
    typeof window !== 'undefined' ? (window as any) : (globalThis as any);
  if (!g.__OFFLINE_QUEUE__) {
    g.__OFFLINE_QUEUE__ = new OfflineQueue();
  }
  return g.__OFFLINE_QUEUE__ as OfflineQueue;
}

export const offlineQueue = getGlobalOfflineQueue();

/**
 * The single helper every caller should use instead of touching
 * `window.api.*` directly when the operation is one we know how to
 * replay offline.
 *
 * Behaviour:
 *   - If the browser reports we're offline → enqueue immediately,
 *     return `{ queued: true }`.
 *   - Otherwise dispatch the call live. On success → `{ queued: false }`.
 *   - On a network-shaped error → enqueue + return `{ queued: true }`.
 *   - On any OTHER error (validation, auth, etc.) → re-throw so the
 *     UI can show its normal error state. We only auto-queue
 *     transport problems.
 */
export async function tryOrQueue<T = unknown>(
  op: OfflineOp,
  args: any,
  options?: { dedupeKey?: string },
): Promise<{ queued: boolean; result?: T; error?: string }> {
  const dispatcher = dispatchers[op];
  if (!dispatcher) {
    throw new Error(`Unknown offline op: ${op}`);
  }
  if (
    typeof navigator !== 'undefined' &&
    !navigator.onLine &&
    !isNativeCapacitor()
  ) {
    await offlineQueue.enqueue(op, args, options);
    return { queued: true };
  }
  try {
    const result = (await dispatcher(args)) as T;
    return { queued: false, result };
  } catch (e: any) {
    if (isLikelyOfflineError(e)) {
      await offlineQueue.enqueue(op, args, options);
      return { queued: true, error: String(e?.message || e) };
    }
    throw e;
  }
}

/** Cheap accessor for badges / status indicators. */
export async function getOfflineQueueCount(): Promise<number> {
  return await offlineQueue.getPendingCount();
}

/** Items that need manual attention (permanently rejected or exhausted). */
export async function getFailedSyncItems(): Promise<FailedSyncItem[]> {
  return await offlineQueue.getFailed();
}

export async function getFailedSyncCount(): Promise<number> {
  return await offlineQueue.getFailedCount();
}

export async function retryFailedSyncItem(
  id: string,
): Promise<{ requeued: boolean }> {
  return await offlineQueue.retryFailed(id);
}

export async function dismissFailedSyncItem(id: string): Promise<void> {
  return await offlineQueue.dismissFailed(id);
}

// Dev-only HMR cleanup — keeps a single live IDB connection across
// reloads and unbinds the old `online` listener.
try {
  const hot = (import.meta as any).hot;
  if (hot) {
    hot.dispose(() => {
      try {
        (offlineQueue as any)?.dispose?.();
      } catch {
        // ignore
      }
      try {
        const g: any =
          typeof window !== 'undefined' ? (window as any) : (globalThis as any);
        delete g.__OFFLINE_QUEUE__;
      } catch {
        // ignore
      }
    });
  }
} catch {
  // ignore
}
