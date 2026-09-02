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
 *   - Bounded at 500 items. Advisory ops are shed oldest-first when the
 *     cap is hit; money ops are never deleted, only moved to the
 *     durable failed surface for manual review.
 *
 * Observability (for PR 4b's sync-status badge):
 *   - Every queue mutation dispatches a `'offline-queue:changed'`
 *     CustomEvent with `{ pending }` so a top-bar badge can subscribe
 *     without polling.
 */

export type OfflineOp =
  | 'tickets.log'
  | 'tickets.print'
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

/** True for operations that create an order or move money. */
export function isMoneyOp(op: OfflineOp): boolean {
  return MONEY_OPS.has(op);
}

/**
 * Operations that must reach the host eventually, even though they don't move
 * money themselves.
 *
 * `tables.setOpen` is here because freeing a table is the other half of taking
 * payment. Treated as advisory it would give up after the retry budget and land
 * on the failed-sync surface, so a paid table stayed red on the floor until
 * somebody noticed and replayed it by hand — and if the failure wasn't
 * network-shaped it was never queued at all, because `tryOrQueue` rethrows for
 * advisory ops and the pay handler deliberately swallows that.
 *
 * Retrying forever is safe here: the write is level-triggered ("this table is
 * closed"), not an increment, so applying it twice is the same as applying it
 * once. `tryOrQueue` drops superseded entries when a newer write for the same
 * table lands, which keeps an unbounded retry from re-closing a table that has
 * since been reopened.
 *
 * `tickets.print` is here for kitchen chits. A lost response used to make the
 * waiter tap Send again, and without a key that printed a second ticket. The
 * print helper now stamps a key before the first attempt; retries of that same
 * intent hit the host's PrintJob unique index and no-op instead of reprinting.
 */
const DURABLE_OPS = new Set<OfflineOp>([
  ...MONEY_OPS,
  'tables.setOpen',
  'tickets.print',
]);

/**
 * True for operations that may never be silently discarded. A superset of
 * {@link isMoneyOp} — money is durable, but not everything durable is money.
 */
export function isDurableOp(op: OfflineOp): boolean {
  return DURABLE_OPS.has(op);
}

/**
 * Failures a retry cannot clear. `FISCAL_NEEDS_REVIEW` needs someone to
 * check easyPos before we dare send again (retrying could file a second
 * invoice). `FISCAL_REJECTED` needs the fiscal configuration or payment
 * method fixed first. Both belong on the failed-sync surface, not in
 * the retry loop.
 */
const NEEDS_RECONCILIATION_CODES = new Set([
  'FISCAL_NEEDS_REVIEW',
  'FISCAL_REJECTED',
]);

/**
 * Host told us the tax invoice was not filed. Queuing these and closing
 * the table made T1 look paid while easyPos had refused the sale.
 * The waiter must see the error and tap Pay again (or change method).
 */
const FISCAL_SALE_BLOCKED_CODES = new Set([
  'FISCAL_NEEDS_REVIEW',
  'FISCAL_REJECTED',
  'FISCAL_FAILED',
]);

/** Another waiter already closed this sitting. Do not queue a second invoice. */
const SALE_ALREADY_SETTLED_CODES = new Set(['TABLE_ALREADY_PAID']);

/**
 * True when a human has to resolve this before the sale can be completed.
 * Distinct from an ordinary permanent rejection (table closed, validation)
 * where the server told us nothing happened and the UI's error is enough.
 */
export function needsManualReconciliation(e: any): boolean {
  return NEEDS_RECONCILIATION_CODES.has(String(e?.code || ''));
}

/** True when fiscalization blocked the sale — the table must stay open. */
export function isFiscalSaleBlocked(e: any): boolean {
  return FISCAL_SALE_BLOCKED_CODES.has(String(e?.code || ''));
}

export function isSaleAlreadySettled(e: any): boolean {
  return SALE_ALREADY_SETTLED_CODES.has(String(e?.code || ''));
}

/** True when retrying cannot change the outcome. */
export function isPermanentFailure(e: any): boolean {
  return e?.permanent === true || needsManualReconciliation(e);
}

/**
 * Translate a `tickets.print` response into success or a thrown error.
 *
 * Both transports report a hard failure as `false`: the Electron IPC
 * handler returns it when fiscalization is rejected, and the mobile
 * client returns it when `/print/ticket` answers non-ok. Treating that
 * as success would delete the queued item and lose the sale.
 *
 * A bare `false` is deliberately NOT permanent — a fiscal provider outage
 * is the usual cause and is transient, so the item stays on the queue as a
 * money op and is retried at the capped backoff. Only an explicit
 * rejection can mark itself permanent.
 */
export function assertPrintAccepted(result: unknown): void {
  if (result === false) {
    const err: any = new Error(
      'Payment was not recorded (fiscalization or printing was rejected)',
    );
    err.code = 'PAYMENT_NOT_RECORDED';
    throw err;
  }
  if (result && typeof result === 'object' && (result as any).ok === false) {
    const r = result as any;
    const err: any = new Error(String(r.error || 'Payment rejected by server'));
    err.code = String(r.code || 'PAYMENT_REJECTED');
    if (r.permanent === true) err.permanent = true;
    throw err;
  }
}

export interface EvictionPlan<T> {
  /** Items that stay on the live queue. */
  kept: T[];
  /** Advisory items discarded outright. */
  evicted: T[];
  /** Money items moved to the durable failed surface instead of dropped. */
  spilled: T[];
}

/**
 * Decide what to shed when the queue exceeds its cap.
 *
 * Eviction must never destroy money or a pending table close. Advisory
 * operations (table colour, covers) are shed oldest-first; only if the queue is
 * still over the cap after shedding all of them do durable operations move —
 * and then to the failed surface for manual replay, never to nothing.
 */
export function planEviction<T extends { op: OfflineOp }>(
  items: T[],
  maxItems: number,
): EvictionPlan<T> {
  if (items.length <= maxItems) {
    return { kept: items, evicted: [], spilled: [] };
  }

  const evicted: T[] = [];
  const survivors: T[] = [];
  let toShed = items.length - maxItems;

  for (const it of items) {
    if (toShed > 0 && !DURABLE_OPS.has(it.op)) {
      evicted.push(it);
      toShed -= 1;
    } else {
      survivors.push(it);
    }
  }

  if (survivors.length > maxItems) {
    return {
      kept: survivors.slice(survivors.length - maxItems),
      evicted,
      spilled: survivors.slice(0, survivors.length - maxItems),
    };
  }
  return { kept: survivors, evicted, spilled: [] };
}

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

/**
 * Restaurant Wi‑Fi often has no internet while the POS host is on LAN.
 * `navigator.onLine === false` is not proof the till is unreachable —
 * money, kitchen tickets, and table closes must try the host first.
 */
export function shouldEnqueueWithoutLiveAttempt(op: OfflineOp): boolean {
  if (DURABLE_OPS.has(op)) return false;
  if (typeof navigator === 'undefined') return false;
  if (isNativeCapacitor()) return false;
  return navigator.onLine === false;
}

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

export const OFFLINE_WAKE_MIN_MS = 250;
export const OFFLINE_WAKE_MAX_MS = 30_000;
/** After an offline abort, items may still be due now — wait this long, don't hammer. */
export const OFFLINE_WAKE_OFFLINE_MS = 5_000;

/**
 * When to run the next `sync()` for items sitting on `nextAttemptAt`.
 * Returns null when the queue is empty (nothing to wake).
 */
export function nextOfflineWakeDelayMs(
  items: Array<{ nextAttemptAt?: number }>,
  now = Date.now(),
): number | null {
  if (!items.length) return null;
  let soonestFuture: number | null = null;
  let hasDue = false;
  for (const it of items) {
    const at = Number(it.nextAttemptAt || 0);
    if (!at || at <= now) {
      hasDue = true;
      continue;
    }
    if (soonestFuture == null || at < soonestFuture) soonestFuture = at;
  }
  if (soonestFuture != null) {
    return Math.max(
      OFFLINE_WAKE_MIN_MS,
      Math.min(OFFLINE_WAKE_MAX_MS, soonestFuture - now),
    );
  }
  if (hasDue) return OFFLINE_WAKE_OFFLINE_MS;
  return null;
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
    // `idempotencyKey` is forwarded to `tickets.print`; both the Electron
    // IPC handler and the LAN `/print/ticket` route dedupe identical keys
    // so a retry cannot double-record a payment audit row (PrintJob).
    assertPrintAccepted(await window.api.tickets.print(a));
  },

  'tickets.print': async (a) => {
    assertPrintAccepted(await window.api.tickets.print(a));
  },
};

class OfflineQueue {
  private dbPromise: Promise<IDBDatabase>;
  private onlineHandler: (() => void) | null = null;
  private startupTimer: number | null = null;
  private wakeTimer: number | null = null;
  private syncing = false;
  // Serialises store read-modify-write critical sections (enqueue, the
  // commit phase of sync, retryFailed) so two writers can't clobber each
  // other's changes. Network I/O deliberately runs OUTSIDE this lock.
  private opLock: Promise<unknown> = Promise.resolve();

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      // Node (unit tests, any SSR-style import) has no IndexedDB. Fail
      // the promise rather than throwing at module load, so importing
      // the pure helpers from this file stays side-effect free.
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable in this environment'));
        return;
      }
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
    // Callers surface the failure when they actually touch the store;
    // this keeps an unopened database from raising an unhandled
    // rejection at import time.
    void this.dbPromise.catch(() => undefined);

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
    this.clearWake();
  }

  private clearWake() {
    if (typeof window === 'undefined') return;
    if (this.wakeTimer != null) {
      window.clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  private armWake(items: Array<{ nextAttemptAt?: number }>) {
    if (typeof window === 'undefined') return;
    this.clearWake();
    const delay = nextOfflineWakeDelayMs(items);
    if (delay == null) return;
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = null;
      void this.sync();
    }, delay);
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

      // Bound the store so a very long outage can't grow IndexedDB
      // without limit (which will OOM a WKWebView on an iPad).
      if (items.length > MAX_ITEMS) {
        const plan = planEviction(items, MAX_ITEMS);
        items = plan.kept;
        for (const it of plan.evicted) this.broadcastDrop(it);
        for (const it of plan.spilled) {
          const failedItem: OfflineQueueItem = {
            ...it,
            lastError: 'Queue overflow — parked for manual review',
          };
          this.broadcastDrop(failedItem);
          await this.recordFailed(failedItem, 'exhausted');
        }
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

  /**
   * Drop queued writes for a target that a newer write has already delivered.
   *
   * Only safe for level-triggered state such as `tables.setOpen`, where the
   * latest value is the whole truth. Callers pass the same `dedupeKey` they
   * would have enqueued under, so this mirrors the latest-wins coalescing in
   * {@link enqueue} for the case where the newer write went out live.
   */
  async purgeSuperseded(dedupeKey: string): Promise<{ removed: number }> {
    if (!dedupeKey) return { removed: 0 };
    return this.withLock(async () => {
      const all = await this.getAll();
      const items = all
        .map(this.normalize)
        .filter((it): it is OfflineQueueItem => it !== null);
      const kept = items.filter((it) => it.dedupeKey !== dedupeKey);
      const removed = items.length - kept.length;
      if (removed > 0) {
        await this.replaceAll(kept);
        this.broadcastChange(kept.length);
      }
      return { removed };
    });
  }

  async sync(): Promise<{ sent: number; remaining: number }> {
    if (this.syncing)
      return { sent: 0, remaining: await this.getPendingCount() };
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
          // Stable idempotency key so the same enqueue can be retried
          // forever without double-processing on the host side.
          //
          // An existing key on the args MUST win. A payment that was
          // attempted live already sent its key to the host; if that
          // call actually landed and only the response was lost,
          // replacing the key here would defeat the host's dedupe and
          // record the payment a second time.
          const args = {
            ...it.args,
            idempotencyKey: String(it.args?.idempotencyKey || '').trim()
              ? it.args.idempotencyKey
              : it.id,
          };
          await dispatcher(args);
          removedIds.add(it.id);
          sent += 1;
          touched = true;
        } catch (e: any) {
          if (isSaleAlreadySettled(e)) {
            removedIds.add(it.id);
            sent += 1;
            touched = true;
            continue;
          }
          // Permanent server rejections (e.g. table is now closed,
          // table owned by another waiter, validation failure) will
          // never succeed on a retry. Drop them immediately and tell
          // the UI so the waiter sees a toast instead of a silent loss.
          if (isPermanentFailure(e)) {
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
            if (DURABLE_OPS.has(it.op)) {
              // NEVER drop an order, a payment, or a table close. The server
              // is the source of truth; keep retrying at the capped backoff
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

      if (touched) {
        await this.commitSync(removedIds, updates);
      }
      const leftover = (await this.getAll())
        .map(this.normalize)
        .filter((it): it is OfflineQueueItem => it !== null);
      this.armWake(leftover);
      return { sent, remaining: leftover.length };
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
  /**
   * Park a live failure that retrying cannot fix directly on the failed
   * surface, without it ever joining the retry queue.
   *
   * The sync loop already does this for items that were queued first; this
   * is the same outcome for one that failed on its first online attempt.
   */
  async parkPermanentFailure(
    op: OfflineOp,
    args: any,
    error: string,
    options?: { dedupeKey?: string },
  ): Promise<void> {
    const item: OfflineQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      op,
      args,
      attempts: 1,
      nextAttemptAt: 0,
      dedupeKey: options?.dedupeKey,
      createdAt: Date.now(),
      lastError: error,
    };
    this.broadcastDrop(item);
    await this.recordFailed(item, 'rejected');
  }

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
 *   - Always try the live host first for money / kitchen / table-close
 *     writes. Tablets on restaurant LAN often have `navigator.onLine ===
 *     false` (no internet) while the POS host is reachable.
 *   - Advisory ops may enqueue immediately when the browser says offline.
 *   - On success → `{ queued: false }`.
 *   - On a network-shaped error → enqueue + return `{ queued: true }`.
 *   - On a fiscal refusal (`FISCAL_*`) → re-throw without enqueueing so
 *     the pay UI can keep the table open. Retrying a refused invoice
 *     after closing the table is what emptied T1 while easyPos said no.
 *   - On `TABLE_ALREADY_PAID` → re-throw without enqueueing (the sitting
 *     is already settled on the host).
 *   - On any other failure of a MONEY op that isn't a permanent
 *     rejection → enqueue (printer / transport after the host accepted
 *     the sale), so a Wi-Fi drop still records the payment.
 *   - On any OTHER error (validation, auth, etc.) → re-throw so the
 *     UI can show its normal error state.
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
  if (shouldEnqueueWithoutLiveAttempt(op)) {
    await offlineQueue.enqueue(op, args, options);
    return { queued: true };
  }
  try {
    const result = (await dispatcher(args)) as T;
    // This write reached the host, so any queued write for the same target is
    // stale by definition. Without this, a close that failed earlier keeps
    // retrying and eventually frees a table that has since been reopened for
    // the next party — a real risk now that durable ops retry indefinitely.
    if (options?.dedupeKey) {
      await offlineQueue
        .purgeSuperseded(options.dedupeKey)
        .catch(() => undefined);
    }
    return { queued: false, result };
  } catch (e: any) {
    // Checked before the offline test on purpose: an indeterminate fiscal
    // outcome must never be re-sent just because its message happens to
    // look network-shaped. Park it where an operator will find it.
    if (needsManualReconciliation(e)) {
      await offlineQueue
        .parkPermanentFailure(op, args, String(e?.message || e), options)
        .catch(() => undefined);
      throw e;
    }
    // easyPos / fiscal middleware refused or timed out the invoice. Do
    // not park this as a queued payment — the table is still occupied
    // and the waiter will pay again (possibly CARD, or a smaller cash
    // amount under the 500,000 ALL individual cash cap).
    if (isFiscalSaleBlocked(e)) {
      throw e;
    }
    if (isSaleAlreadySettled(e)) {
      throw e;
    }
    if (isLikelyOfflineError(e)) {
      await offlineQueue.enqueue(op, args, options);
      return { queued: true, error: String(e?.message || e) };
    }
    // A durable op that failed for any reason other than a permanent
    // rejection or a fiscal block must not evaporate. Printer / transport
    // failures after the host accepted the sale still enqueue so a Wi-Fi
    // drop cannot lose a recorded payment. Fiscal refusals are thrown
    // above so the pay UI keeps the table open.
    if (DURABLE_OPS.has(op) && !isPermanentFailure(e)) {
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
