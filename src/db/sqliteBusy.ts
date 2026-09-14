/**
 * SQLite allows many readers but only one writer. Peak service (pay, send,
 * print-ack, KDS bump, occupancy) overlaps those writers. Without a busy
 * timeout the second writer fails immediately and tablets treat a healthy
 * LAN as offline.
 */

export const SQLITE_BUSY_TIMEOUT_MS = 8_000;

/**
 * Interactive transactions must outlive `busy_timeout`. Prisma's 5s default
 * expires while SQLite is still waiting, then the next statement hits
 * "Transaction already closed".
 */
export const SQLITE_TX_TIMEOUT_MS = 20_000;

const RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800];

export function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    message?: unknown;
    meta?: { message?: unknown; code?: unknown };
  };
  const code = String(e.code || e.meta?.code || '');
  if (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === 'P1008' ||
    code === 'P2024' ||
    code === 'P2034'
  ) {
    return true;
  }
  const message = `${e.message || ''} ${e.meta?.message || ''}`.toLowerCase();
  return (
    message.includes('database is locked') ||
    message.includes('sqlite_busy') ||
    message.includes('sqlite_locked') ||
    message.includes('database is busy')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withSqliteRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isSqliteBusy(err) || i === delaysMs.length) throw err;
      await sleep(delaysMs[i]!);
    }
  }
  throw last;
}

/** Fill Prisma `$transaction` options so timeout is never below busy_timeout. */
export function withSqliteTransactionOptions(args: unknown[]): unknown[] {
  const [first, second] = args;
  if (typeof first !== 'function' && !Array.isArray(first)) return args;
  const opts =
    second && typeof second === 'object' && !Array.isArray(second)
      ? { ...(second as Record<string, unknown>) }
      : {};
  if (opts.timeout == null) opts.timeout = SQLITE_TX_TIMEOUT_MS;
  if (opts.maxWait == null) opts.maxWait = SQLITE_BUSY_TIMEOUT_MS;
  return [first, opts, ...args.slice(2)];
}
