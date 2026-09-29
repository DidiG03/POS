/**
 * One DateTime format on the encrypted ledger.
 *
 * Prisma's native SQLite engine (plain ledger) stores a DateTime as INTEGER
 * milliseconds. The libSQL driver adapter (encrypted ledger) writes TEXT —
 * `2026-09-29T22:55:37.894+00:00` — and compares against TEXT parameters.
 * SQLite orders every INTEGER before every TEXT, so once a till's plain
 * ledger was copied into an encrypted one (`encryptPlaintextSqlite` copies
 * values as they are), every row written before encryption was invisible
 * to `gte` filters (reports, "today", recent fiscal claims) and matched
 * every `lt` filter (retention treated it all as old).
 *
 * This rewrites those values into the adapter's own format. It is
 * idempotent and leaves a marker so a normal open costs one key lookup.
 */

export interface SqlRunner {
  query(sql: string, args?: unknown[]): Promise<Array<Record<string, unknown>>>;
  /** Returns the number of rows changed. */
  exec(sql: string, args?: unknown[]): Promise<number>;
}

export const DATETIME_TEXT_MARKER_KEY = 'db:datetimeText';

/** The libSQL adapter's DateTime text: millisecond ISO with `+00:00`. */
export function adapterDateTimeText(date: Date): string {
  return date.toISOString().replace(/Z$/, '+00:00');
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `CURRENT_TIMESTAMP` style: `2026-09-29 22:55:37`, UTC, no zone. */
const SQLITE_DEFAULT_TEXT_GLOB =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]*';

function rewriteColumnSql(table: string, column: string): string {
  const t = quoteIdent(table);
  const c = quoteIdent(column);
  // Integer division and modulo keep the milliseconds exact; going through
  // a REAL (`c / 1000.0`) can round a value one millisecond off.
  return (
    `UPDATE ${t} SET ${c} = CASE ` +
    `WHEN typeof(${c}) = 'integer' THEN ` +
    `strftime('%Y-%m-%dT%H:%M:%S', ${c} / 1000, 'unixepoch') || '.' || ` +
    `printf('%03d', ${c} % 1000) || '+00:00' ` +
    `ELSE strftime('%Y-%m-%dT%H:%M:%f', ${c}) || '+00:00' END ` +
    `WHERE (typeof(${c}) = 'integer' AND ${c} >= 0) ` +
    `OR (typeof(${c}) = 'text' AND ${c} GLOB '${SQLITE_DEFAULT_TEXT_GLOB}')`
  );
}

async function tableExists(db: SqlRunner, name: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return rows.length > 0;
}

/** Every declared DATETIME column, by table. Prisma's own tables excluded. */
export async function listDatetimeColumns(
  db: SqlRunner,
): Promise<Array<{ table: string; columns: string[] }>> {
  const tables = await db.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' ` +
      `AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_prisma%' ESCAPE '\\'`,
  );
  const out: Array<{ table: string; columns: string[] }> = [];
  for (const row of tables) {
    const table = String(row.name || '');
    if (!table) continue;
    const cols = await db.query(`PRAGMA table_info(${quoteIdent(table)})`);
    const columns = cols
      .filter((c) => String(c.type || '').toUpperCase() === 'DATETIME')
      .map((c) => String(c.name || ''))
      .filter(Boolean);
    if (columns.length) out.push({ table, columns });
  }
  return out;
}

export async function normalizeDatetimeStorage(
  db: SqlRunner,
  options?: { now?: Date; force?: boolean },
): Promise<{ skipped: boolean; updated: number }> {
  const hasSyncState = await tableExists(db, 'SyncState');
  if (hasSyncState && !options?.force) {
    const marker = await db.query(
      `SELECT 1 AS ok FROM "SyncState" WHERE "key" = ?`,
      [DATETIME_TEXT_MARKER_KEY],
    );
    if (marker.length > 0) return { skipped: true, updated: 0 };
  }

  let updated = 0;
  for (const { table, columns } of await listDatetimeColumns(db)) {
    for (const column of columns) {
      updated += await db.exec(rewriteColumnSql(table, column));
    }
  }

  // A brand-new ledger has no SyncState until the schema is applied; it is
  // checked again (cheaply, on an empty ledger) on the next open.
  if (hasSyncState) {
    const at = adapterDateTimeText(options?.now ?? new Date());
    await db.exec(
      `INSERT OR REPLACE INTO "SyncState" ("key", "valueJson", "updatedAt") VALUES (?, ?, ?)`,
      [DATETIME_TEXT_MARKER_KEY, JSON.stringify({ v: 1, updated, at }), at],
    );
  }
  return { skipped: false, updated };
}
