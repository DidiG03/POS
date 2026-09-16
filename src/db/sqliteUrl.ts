import path from 'node:path';

/**
 * WAL lets many readers proceed while one writer runs. Prisma's pool must
 * be small enough that writers do not stampede SQLite, and large enough
 * that floor/KDS reads are not stuck behind a pay.
 *
 * Writes are also serialized in-process (`AsyncMutex` + retry). The pool
 * is for concurrent readers.
 */
export const SQLITE_CONNECTION_LIMIT = 4;

export function sqliteFileUrl(file: string): string {
  return `file:${path.resolve(file).split(path.sep).join('/')}`;
}

export function sqliteConnectionUrl(
  raw: string | undefined | null,
  fallback = 'file:./dev.db',
): string {
  const url = String(raw || '').trim() || fallback;
  if (/[?&]connection_limit=/i.test(url)) return url;
  const extra = `connection_limit=${SQLITE_CONNECTION_LIMIT}`;
  return url.includes('?') ? `${url}&${extra}` : `${url}?${extra}`;
}
