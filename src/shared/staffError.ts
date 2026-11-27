/**
 * Errors staff can read.
 *
 * With the ledger stalled (another write holding it for over a minute) a
 * waiter's "Paying…" spun for 73 s and then showed "Invalid
 * `prisma.syncState.create()` invocation… Socket timeout". Nothing was
 * taken (no payment, no invoice) and a retry with the same key gave one
 * payment, but the words were the ORM's. A database failure now reads
 * "The till is busy, payment not taken — try again" with the code
 * TILL_BUSY, which is retryable: the replay is deduped by its key.
 */

export const TILL_BUSY = 'TILL_BUSY';

export const TILL_BUSY_MESSAGE =
  'The till is busy, so the payment was not taken. Try again in a moment.';
export const TILL_BUSY_MESSAGE_GENERIC =
  'The till is busy and could not save this. Try again in a moment.';

const DB_TEXT =
  /invalid `prisma\.|prisma\.\w+\.\w+\(\)|invocation|socket timeout|sqlite_busy|sqlite_locked|database is locked|database table is locked|timed out fetching a new connection|connection pool|prismaclient|query engine|p1001|p1008|p1017|p2024|p2034/i;

const DB_CODES = new Set(['P1001', 'P1008', 'P1017', 'P2024', 'P2034']);

function textOf(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  const e = error as { message?: unknown; name?: unknown; code?: unknown };
  return [e.name, e.code, e.message].map((v) => String(v ?? '')).join(' ');
}

/** True for a database/ORM failure (busy, locked, timed out, engine gone). */
export function isDatabaseError(error: unknown): boolean {
  if (error == null) return false;
  const e = error as { name?: unknown; code?: unknown };
  if (String(e?.name || '').startsWith('PrismaClient')) {
    // A unique-constraint race (P2002) is a business outcome, not a stall.
    return String(e?.code || '') !== 'P2002';
  }
  if (DB_CODES.has(String(e?.code || ''))) return true;
  return DB_TEXT.test(textOf(error));
}

/** Looks like a stack trace or internal dump rather than a sentence. */
function looksInternal(text: string): boolean {
  return /\n\s+at\s|\bat .+\(.+:\d+:\d+\)|node_modules|\.ts:\d+|\.js:\d+/.test(
    text,
  );
}

/**
 * A message fit for a waiter: database failures become "the till is
 * busy", stack traces are cut, anything else is returned as it is.
 */
export function staffSafeMessage(
  message: unknown,
  opts: { payment?: boolean } = {},
): string {
  const text = String(
    typeof message === 'string' ? message : textOf(message),
  ).trim();
  if (isDatabaseError(message) || DB_TEXT.test(text)) {
    return opts.payment ? TILL_BUSY_MESSAGE : TILL_BUSY_MESSAGE_GENERIC;
  }
  if (looksInternal(text)) {
    const first = text.split('\n')[0].trim();
    return first && !looksInternal(first)
      ? first.slice(0, 240)
      : TILL_BUSY_MESSAGE_GENERIC;
  }
  return text;
}
