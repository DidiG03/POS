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
  const source = path.resolve(opts.sourceFile);
  const dest = path.resolve(opts.destFile);
  if (source === dest) {
    throw new Error('Cannot encrypt a database onto itself');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);

  const src = openLibsql(source);
  const dst = openLibsql(dest, opts.encryptionKey);
  try {
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

    for (const row of objects.rows) {
      const type = String(row.type || '');
      const name = String(row.name || '');
      const sql = String(row.sql || '');
      if (!name || !sql) continue;
      if (type === 'table') {
        await dst.execute(sql);
        const ident = quoteIdent(name);
        await copyTablePaged(src, dst, ident);
      }
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
  } finally {
    await closeQuietly(dst);
    await closeQuietly(src);
  }

  if (!looksLikeSqliteCiphertext(dest)) {
    throw new Error('Encrypted database was not written');
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
