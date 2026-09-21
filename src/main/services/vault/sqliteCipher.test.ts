import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { sqliteFileUrl } from '@db/sqliteUrl';
import {
  encryptPlaintextSqlite,
  isPlaintextSqlite,
  looksLikeSqliteCiphertext,
  verifyEncryptedSqlite,
} from './sqliteCipher';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cipher-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('encryptPlaintextSqlite', () => {
  it('copies tables and unique indexes into a ciphertext file', async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'plain.db');
    const dest = path.join(dir, 'enc.db');
    const key = 'ab'.repeat(32);

    const client = createClient({ url: `file:${src}` });
    await client.execute(
      'CREATE TABLE "User" (id INTEGER PRIMARY KEY, name TEXT, externalId TEXT)',
    );
    await client.execute(
      'CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId")',
    );
    await client.execute(
      `INSERT INTO "User" (name, externalId) VALUES ('Ada', 'ext-1')`,
    );
    await client.close();
    expect(isPlaintextSqlite(src)).toBe(true);

    await encryptPlaintextSqlite({
      sourceFile: src,
      destFile: dest,
      encryptionKey: key,
    });

    expect(looksLikeSqliteCiphertext(dest)).toBe(true);
    expect(isPlaintextSqlite(dest)).toBe(false);
    expect(await verifyEncryptedSqlite(dest, key)).toBe(true);
    expect(await verifyEncryptedSqlite(dest, 'cd'.repeat(32))).toBe(false);

    try {
      const bad = createClient({ url: `file:${dest}` });
      await bad.execute('SELECT name FROM "User"');
      await bad.close();
      throw new Error('opened ciphertext without a key');
    } catch (e) {
      expect(String((e as Error).message || e)).not.toContain(
        'opened ciphertext without a key',
      );
    }

    const enc = createClient({ url: `file:${dest}`, encryptionKey: key });
    const rows = await enc.execute('SELECT name, externalId FROM "User"');
    expect(rows.rows).toEqual([{ name: 'Ada', externalId: 'ext-1' }]);
    await enc.close();
  });

  it('copies tables larger than one page', async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'plain.db');
    const dest = path.join(dir, 'enc.db');
    const key = 'ab'.repeat(32);
    const client = createClient({ url: `file:${src}` });
    await client.execute(
      'CREATE TABLE "Item" (id INTEGER PRIMARY KEY, name TEXT)',
    );
    // One multi-row INSERT keeps this under Vitest's 5s CI budget — 250
    // sequential round-trips were flaking on GitHub runners.
    const values = Array.from({ length: 250 }, (_, i) => `('n${i}')`).join(',');
    await client.execute(`INSERT INTO "Item" (name) VALUES ${values}`);
    await client.close();

    await encryptPlaintextSqlite({
      sourceFile: src,
      destFile: dest,
      encryptionKey: key,
    });

    const enc = createClient({ url: `file:${dest}`, encryptionKey: key });
    const count = await enc.execute('SELECT COUNT(*) AS n FROM "Item"');
    expect(Number(count.rows[0]?.n)).toBe(250);
    await enc.close();
  });

  it('encrypts a ledger whose folder name contains a space', async () => {
    const dir = path.join(tmpDir(), 'OneTap POS');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'plain.db');
    const dest = path.join(dir, 'enc.db');
    const key = 'ab'.repeat(32);
    const client = createClient({ url: sqliteFileUrl(src) });
    await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await client.close();
    await encryptPlaintextSqlite({
      sourceFile: src,
      destFile: dest,
      encryptionKey: key,
    });
    expect(await verifyEncryptedSqlite(dest, key)).toBe(true);
  });
});
