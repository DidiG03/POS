/**
 * Keeps security events (`security.ts`) in the database.
 *
 * They used to live in a 1,000-entry array in memory: a restart, or a burst
 * of refused requests, removed the record of a lockout or of the ledger
 * being erased.
 *
 * A flood of refused requests must not turn into a flood of database
 * writes (every write takes the till's single write lock), so at most
 * `MAX_ROWS_PER_WINDOW` rows are written per minute. What is left out is
 * counted and written as one `security_log_suppressed` row when the next
 * minute starts. Events that arrive while the ledger is still locked wait
 * in a short queue.
 */

export const MAX_ROWS_PER_WINDOW = 120;
export const WINDOW_MS = 60_000;
export const MAX_PENDING = 500;
export const MAX_DETAILS_CHARS = 4_000;
export const RETENTION_DAYS = 365;

export type SecurityEventRow = {
  event: string;
  detailsJson: unknown;
  createdAt: Date;
};

export type SecurityEventDb = {
  securityEvent: {
    create: (args: { data: SecurityEventRow }) => Promise<unknown>;
    findMany: (args: object) => Promise<
      Array<{
        event: string;
        detailsJson: unknown;
        createdAt: Date | string;
      }>
    >;
    deleteMany: (args: object) => Promise<{ count: number }>;
  };
};

type StoreDeps = {
  db: () => SecurityEventDb;
  /** False while the ledger cannot be written (vault still locked). */
  ready: () => boolean;
  now?: () => number;
  onError?: (err: unknown) => void;
};

/** Details as plain JSON, cut to a size that cannot bloat the table. */
export function storableDetails(details: unknown): unknown {
  if (details === undefined || details === null) return null;
  let text: string;
  try {
    text = JSON.stringify(details);
  } catch {
    return { note: 'details could not be saved' };
  }
  if (text === undefined) return null;
  if (text.length <= MAX_DETAILS_CHARS) return JSON.parse(text);
  return { truncated: true, text: text.slice(0, MAX_DETAILS_CHARS) };
}

export function createSecurityEventStore(deps: StoreDeps) {
  const now = deps.now ?? (() => Date.now());
  const pending: SecurityEventRow[] = [];
  let windowStart = 0;
  let writtenInWindow = 0;
  let suppressed = 0;
  let flushing: Promise<void> | null = null;

  function admit(row: SecurityEventRow): void {
    const t = row.createdAt.getTime();
    if (t - windowStart >= WINDOW_MS) {
      if (suppressed > 0) {
        enqueue({
          event: 'security_log_suppressed',
          detailsJson: { count: suppressed, windowMs: WINDOW_MS },
          createdAt: new Date(t),
        });
      }
      windowStart = t;
      writtenInWindow = 0;
      suppressed = 0;
    }
    if (writtenInWindow >= MAX_ROWS_PER_WINDOW) {
      suppressed += 1;
      return;
    }
    writtenInWindow += 1;
    enqueue(row);
  }

  function enqueue(row: SecurityEventRow): void {
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push(row);
  }

  async function flushNow(): Promise<void> {
    while (pending.length > 0) {
      if (!deps.ready()) return;
      const row = pending[0]!;
      try {
        await deps.db().securityEvent.create({ data: row });
      } catch (err) {
        // Kept for the next event's flush; reported, not thrown: recording
        // an event must never fail the request that caused it.
        deps.onError?.(err);
        return;
      }
      pending.shift();
    }
  }

  function flush(): Promise<void> {
    if (!flushing) {
      flushing = flushNow().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  return {
    /** Record one event. Returns when it is written or queued. */
    record(event: string, details: unknown): Promise<void> {
      admit({
        event: String(event || '').slice(0, 120),
        detailsJson: storableDetails(details),
        createdAt: new Date(now()),
      });
      return flush();
    },
    flush,
    /** Newest first, in the shape Admin already reads. */
    async list(
      limit = 100,
    ): Promise<Array<{ timestamp: number; event: string; details: unknown }>> {
      const rows = await deps.db().securityEvent.findMany({
        orderBy: { id: 'desc' },
        take: Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100))),
      });
      return rows.map((r) => ({
        timestamp: new Date(r.createdAt).getTime(),
        event: r.event,
        details: r.detailsJson ?? null,
      }));
    },
    async prune(days = RETENTION_DAYS): Promise<number> {
      const cutoff = new Date(now() - Math.max(1, days) * 86_400_000);
      const res = await deps.db().securityEvent.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      return Number(res?.count || 0);
    },
    pendingCount: () => pending.length,
  };
}

export type SecurityEventStore = ReturnType<typeof createSecurityEventStore>;
