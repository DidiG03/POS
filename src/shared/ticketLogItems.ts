/**
 * TicketLog.itemsJson / createdAt as they actually come off SQLite.
 *
 * Prisma's SQLite DateTime column is sometimes an ISO string and sometimes
 * epoch milliseconds. A `{ createdAt: { gte: Date } }` filter can therefore
 * drop every row for the current sitting — the order panel then paints an
 * empty ticket on an occupied table. Parsing here keeps session bounds in JS
 * so a missed SQL match still finds the bill.
 */

export function asTicketLogItems(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  if (depth > 2) return [];
  if (typeof value === 'string' && value.trim()) {
    try {
      return asTicketLogItems(JSON.parse(value), depth + 1);
    } catch {
      return [];
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.lines)) return obj.lines;
  }
  return [];
}

export function ticketLogCreatedAtMs(value: unknown): number {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : NaN;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return n > 0 && n < 1e12 ? n * 1000 : n;
    }
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
}

/** IPC/HTTP must not call `.toISOString()` on epoch-ms DateTime values. */
export function ticketCreatedAtIso(value: unknown): string {
  const ms = ticketLogCreatedAtMs(value);
  return Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : new Date().toISOString();
}

/**
 * Inclusive createdAt window in JS. Use this after a SQLite read — Prisma
 * `{ createdAt: { gte: Date } }` misses epoch-ms rows.
 */
export function ticketLogInRange(
  createdAt: unknown,
  startMs?: number,
  endMs?: number,
): boolean {
  const t = ticketLogCreatedAtMs(createdAt);
  if (!Number.isFinite(t)) return false;
  if (typeof startMs === 'number' && Number.isFinite(startMs) && t < startMs) {
    return false;
  }
  if (typeof endMs === 'number' && Number.isFinite(endMs) && t > endMs) {
    return false;
  }
  return true;
}

/**
 * SQLite `TicketLog.createdAt` is TEXT ISO or INTEGER ms/sec. Prisma Date
 * filters only match one of those, so admin/reports use this CASE instead.
 */
export function ticketLogCreatedAtRangeSql(
  startMs?: number,
  endMs?: number,
): { sql: string; params: Array<string | number> } | null {
  const hasStart = typeof startMs === 'number' && Number.isFinite(startMs);
  const hasEnd = typeof endMs === 'number' && Number.isFinite(endMs);
  if (!hasStart && !hasEnd) return null;
  const start = hasStart ? startMs! : 0;
  const end = hasEnd ? endMs! : 8.64e15;
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const startSec = Math.floor(start / 1000);
  const endSec = Math.ceil(end / 1000);
  return {
    sql: `(
      (
        typeof(createdAt) IN ('integer', 'real')
        AND (
          (createdAt >= ? AND createdAt <= ?)
          OR (createdAt >= ? AND createdAt <= ?)
        )
      )
      OR (
        typeof(createdAt) NOT IN ('integer', 'real')
        AND (
          (createdAt >= ? AND createdAt <= ?)
          OR (
            createdAt GLOB '[0-9]*'
            AND createdAt NOT GLOB '*[^0-9]*'
            AND (
              (CAST(createdAt AS INTEGER) >= ? AND CAST(createdAt AS INTEGER) <= ?)
              OR (CAST(createdAt AS INTEGER) >= ? AND CAST(createdAt AS INTEGER) <= ?)
            )
          )
        )
      )
    )`,
    params: [
      start,
      end,
      startSec,
      endSec,
      startIso,
      endIso,
      start,
      end,
      startSec,
      endSec,
    ],
  };
}

/** Same 2s slack as `cacheLooksLikeCurrentSession` — clock skew at open. */
export const SESSION_START_SLACK_MS = 2000;

export function rowIsInOpenSession(
  createdAt: unknown,
  sessionStartMs: number,
  slackMs = SESSION_START_SLACK_MS,
): boolean {
  const t = ticketLogCreatedAtMs(createdAt);
  return Number.isFinite(t) && t >= sessionStartMs - slackMs;
}
