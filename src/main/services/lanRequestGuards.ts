/**
 * Small request checks for the LAN API (`api.ts`), kept here so they can be
 * tested without starting the server.
 */

/**
 * True when a request body is declared as JSON.
 *
 * A web page in any browser on the till can send a "simple" POST (for
 * example `text/plain`) to http://127.0.0.1:3333 without a CORS preflight.
 * Kitchen routes trust the till's own machine without a token, so such a
 * page could clear or bump tickets. Requiring `application/json` forces the
 * browser to ask first (preflight), and CORS then refuses foreign pages.
 * Every OneTap client already sends this header.
 */
export function isJsonContentType(
  header: string | string[] | undefined,
): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  const type = String(raw || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return type === 'application/json';
}

/** Methods that carry a body and change state. */
export function isWriteMethod(method: string | undefined): boolean {
  const m = String(method || 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

export type OptionalDate =
  | { ok: true; date: Date | undefined }
  | { ok: false; error: string };

/**
 * An optional ISO date from a query string. Missing → `undefined`; garbage
 * → an error the route answers with 400 (an Invalid Date used to reach
 * Prisma and come back as a 500).
 */
export function parseOptionalIsoDate(raw: unknown, name: string): OptionalDate {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') {
    return { ok: true, date: undefined };
  }
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    return { ok: false, error: `invalid ${name}` };
  }
  return { ok: true, date };
}

/**
 * Most live-update streams one signed-in user may hold from one address.
 * A phone or browser needs one or two (a reconnect can briefly overlap);
 * a few tabs of Admin stay well under this.
 */
export const MAX_EVENT_STREAMS_PER_DEVICE = 6;

export type EventStreamClient = { userId: number; remoteIp?: string };

/**
 * The streams to close before a new one opens, oldest first, so the user
 * and address keep at most `max` including the new one. `clients` must be
 * in opening order (a `Set` keeps insertion order).
 */
export function eventStreamsToClose<T extends EventStreamClient>(
  clients: Iterable<T>,
  userId: number,
  remoteIp: string,
  max: number = MAX_EVENT_STREAMS_PER_DEVICE,
): T[] {
  const same: T[] = [];
  for (const c of clients) {
    if (c.userId === userId && String(c.remoteIp || '') === remoteIp) {
      same.push(c);
    }
  }
  const excess = same.length + 1 - Math.max(1, max);
  return excess > 0 ? same.slice(0, excess) : [];
}
