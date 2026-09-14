/**
 * TicketLog.itemsJson / createdAt as they actually come off SQLite.
 *
 * Prisma's SQLite DateTime column is sometimes an ISO string and sometimes
 * epoch milliseconds. A `{ createdAt: { gte: Date } }` filter can therefore
 * drop every row for the current sitting — the order panel then paints an
 * empty ticket on an occupied table. Parsing here keeps session bounds in JS
 * so a missed SQL match still finds the bill.
 */

export function asTicketLogItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
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
