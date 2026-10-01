/**
 * libSQL encryption-at-rest helpers.
 *
 * A plaintext SQLite file cannot be "rekeyed". We copy schema and rows into
 * a new encrypted file, then the caller shreds the original.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient, type Client, type InValue } from '@libsql/client';
import { SQLITE_BUSY_TIMEOUT_MS } from '@db/sqliteBusy';
import { sqliteFileUrl } from '@db/sqliteUrl';
import {
  DATETIME_TEXT_MARKER_KEY,
  datetimeToIntegerStorage,
  normalizeDatetimeStorage,
  type SqlRunner,
} from '@db/datetimeText';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

export function isPlaintextSqlite(file: string): boolean {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < SQLITE_MAGIC.length) {
      return false;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(SQLITE_MAGIC.length);
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.equals(SQLITE_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function looksLikeSqliteCiphertext(file: string): boolean {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= 0) return false;
    return !isPlaintextSqlite(file);
  } catch {
    return false;
  }
}

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

const COPY_PAGE = 200;

function bindValue(value: unknown): InValue {
  if (value == null) return null;
  if (value instanceof Date) return value;
  // libSQL returns BLOBs as ArrayBuffer; JSON.stringify would turn them into "{}".
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array)
  ) {
    return JSON.stringify(value);
  }
  return value as InValue;
}

async function closeQuietly(client: Client | null): Promise<void> {
  if (!client) return;
  try {
    client.close();
  } catch {
    // ignore
  }
}

async function copyTablePaged(
  src: Client,
  dst: Client,
  ident: string,
): Promise<void> {
  let offset = 0;
  for (;;) {
    const data = await src.execute(
      `SELECT * FROM ${ident} LIMIT ${COPY_PAGE} OFFSET ${offset}`,
    );
    const cols = data.columns || [];
    const rows = data.rows || [];
    if (!cols.length || !rows.length) break;
    const insertSql = `INSERT INTO ${ident} (${cols.map(quoteIdent).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const stmts = rows.map((r) => ({
      sql: insertSql,
      args: cols.map((col) => bindValue((r as Record<string, unknown>)[col])),
    }));
    for (let i = 0; i < stmts.length; i += 80) {
      await dst.batch(stmts.slice(i, i + 80), 'write');
    }
    if (rows.length < COPY_PAGE) break;
    offset += COPY_PAGE;
  }
}

function libsqlRunner(client: Client): SqlRunner {
  return {
    query: async (sql, args = []) =>
      (await client.execute({ sql, args: args as InValue[] })).rows as Array<
        Record<string, unknown>
      >,
    exec: async (sql, args = []) =>
      (await client.execute({ sql, args: args as InValue[] })).rowsAffected,
  };
}

export function openLibsql(file: string, encryptionKey?: string): Client {
  return createClient({
    url: sqliteFileUrl(file),
    ...(encryptionKey ? { encryptionKey, concurrency: 1 as const } : {}),
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
}

/**
 * Copy a plaintext SQLite file into a new encrypted file using the same DEK
 * the vault will hand Prisma.
 */
export async function encryptPlaintextSqlite(opts: {
  sourceFile: string;
  destFile: string;
  encryptionKey: string;
}): Promise<void> {
  await copySqliteDatabase({
    sourceFile: opts.sourceFile,
    destFile: opts.destFile,
    destKey: opts.encryptionKey,
  });
  if (!looksLikeSqliteCiphertext(opts.destFile)) {
    throw new Error('Encrypted database was not written');
  }
}

/**
 * Copy every table, index, trigger and AUTOINCREMENT counter of one SQLite
 * file into a new file, row by row. Either side may be encrypted (pass its
 * key) or plain. Rebuilding this way also drops any damage in the file's
 * page layout that does not affect the rows themselves.
 *
 * DateTimes are stored the way the destination's engine expects: TEXT for
 * an encrypted ledger (libSQL adapter), INTEGER milliseconds for a plain one
 * (Prisma's native engine).
 */
export async function copySqliteDatabase(opts: {
  sourceFile: string;
  sourceKey?: string;
  destFile: string;
  destKey?: string;
}): Promise<void> {
  const source = path.resolve(opts.sourceFile);
  const dest = path.resolve(opts.destFile);
  if (source === dest) {
    throw new Error('Cannot copy a database onto itself');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const src = openLibsql(source, opts.sourceKey);
  const dst = openLibsql(dest, opts.destKey);
  try {
    // libSQL enforces foreign keys by default, and tables are copied in name
    // order: a row pointing at "User" would be refused before "User" exists.
    // The rows are copied exactly as they are, so nothing is checked here.
    await dst.execute('PRAGMA foreign_keys=OFF');
    await src.execute('PRAGMA busy_timeout=8000');
    try {
      await src.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // empty or already checkpointed
    }

    const objects = await src.execute(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type
         WHEN 'table' THEN 0
         WHEN 'index' THEN 1
         WHEN 'trigger' THEN 2
         ELSE 3
       END, name`,
    );

    const tables = objects.rows.filter(
      (row) =>
        String(row.type || '') === 'table' && row.name != null && row.sql,
    );
    for (const row of tables) await dst.execute(String(row.sql));
    for (const row of tables) {
      await copyTablePaged(src, dst, quoteIdent(String(row.name)));
    }

    for (const row of objects.rows) {
      const type = String(row.type || '');
      const sql = String(row.sql || '');
      if (type === 'table' || !sql) continue;
      await dst.execute(sql);
    }

    try {
      const seq = await src.execute('SELECT name, seq FROM sqlite_sequence');
      for (const row of seq.rows) {
        await dst.execute({
          sql: 'INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)',
          args: [row.name, row.seq],
        });
      }
    } catch {
      // no sqlite_sequence
    }

    if (opts.destKey) {
      // The plain ledger's integer DateTimes would never match the encrypted
      // ledger's TEXT comparisons. Store them the way the adapter does.
      await normalizeDatetimeStorage(libsqlRunner(dst), { force: true });
    } else {
      await datetimeToIntegerStorage(libsqlRunner(dst));
    }
    try {
      await dst.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // not in WAL mode
    }
  } finally {
    await closeQuietly(dst);
    await closeQuietly(src);
  }
}

/** `PRAGMA integrity_check` lines; `['ok']` when the file is healthy. */
export async function sqliteIntegrityCheck(
  file: string,
  encryptionKey?: string,
): Promise<string[]> {
  const client = openLibsql(file, encryptionKey);
  try {
    const result = await client.execute('PRAGMA integrity_check(50)');
    return result.rows.map((r) => String(Object.values(r)[0] ?? ''));
  } finally {
    await closeQuietly(client);
  }
}

/** Row count of every user table, to prove a copy kept everything. */
export async function sqliteRowCounts(
  file: string,
  encryptionKey?: string,
): Promise<Record<string, number>> {
  const client = openLibsql(file, encryptionKey);
  try {
    const tables = await client.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    const out: Record<string, number> = {};
    for (const row of tables.rows) {
      const name = String(row.name || '');
      if (!name) continue;
      // The DateTime-format marker is bookkeeping that a decrypted copy drops
      // on purpose; it is not a record.
      const r = await client.execute(
        name === 'SyncState'
          ? {
              sql: `SELECT COUNT(*) AS n FROM "SyncState" WHERE "key" != ?`,
              args: [DATETIME_TEXT_MARKER_KEY],
            }
          : `SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`,
      );
      out[name] = Number(r.rows[0]?.n ?? 0);
    }
    return out;
  } finally {
    await closeQuietly(client);
  }
}

export async function verifyEncryptedSqlite(
  file: string,
  encryptionKey: string,
): Promise<boolean> {
  const client = openLibsql(file, encryptionKey);
  try {
    await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1",
    );
    return true;
  } catch {
    return false;
  } finally {
    await closeQuietly(client);
  }
}
