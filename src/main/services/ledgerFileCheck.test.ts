import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { checkLedgerFile } from './ledgerFileCheck';
import { encryptPlaintextSqlite } from './vault/sqliteCipher';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-ledgercheck-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function makeLedger(file: string, rows = 400, staff = true) {
  const client = createClient({ url: `file:${file}` });
  if (staff) {
    await client.execute(
      'CREATE TABLE "User" (id INTEGER PRIMARY KEY, displayName TEXT)',
    );
    await client.execute(`INSERT INTO "User" (displayName) VALUES ('Owner')`);
  }
  await client.execute(
    'CREATE TABLE "TicketLog" (id INTEGER PRIMARY KEY, note TEXT)',
  );
  await client.execute('CREATE INDEX "TicketLog_note" ON "TicketLog"(note)');
  for (let i = 0; i < rows; i += 50) {
    await client.batch(
      Array.from({ length: 50 }, (_, j) => ({
        sql: 'INSERT INTO "TicketLog" (note) VALUES (?)',
        args: [`row ${i + j} ${'x'.repeat(200)}`],
      })),
    );
  }
  client.close();
}

describe('checkLedgerFile', () => {
  it('accepts a sound ledger and leaves no extra files beside it', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'pos-backup.db');
    await makeLedger(file);
    expect(await checkLedgerFile(file)).toEqual({ ok: true });
    expect(fs.readdirSync(dir)).toEqual(['pos-backup.db']);
  });

  it('refuses a missing or empty file', async () => {
    const dir = tmpDir();
    const missing = await checkLedgerFile(path.join(dir, 'nope.db'));
    expect(missing).toMatchObject({ ok: false, reason: 'missing' });
    const empty = path.join(dir, 'empty.db');
    fs.writeFileSync(empty, '');
    expect(await checkLedgerFile(empty)).toMatchObject({
      ok: false,
      reason: 'empty',
    });
  });

  it('refuses a backup that was cut short', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'cut.db');
    await makeLedger(file);
    const full = fs.readFileSync(file);
    fs.writeFileSync(file, full.subarray(0, Math.floor(full.length / 2)));
    const verdict = await checkLedgerFile(file);
    expect(verdict.ok).toBe(false);
  });

  it('refuses a backup with damaged pages', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'damaged.db');
    await makeLedger(file);
    const bytes = fs.readFileSync(file);
    // Scribble over pages in the middle, past the header and schema.
    for (let i = 8192; i < bytes.length - 4096; i += 4096) {
      bytes.fill(0xa5, i + 100, i + 600);
    }
    fs.writeFileSync(file, bytes);
    const verdict = await checkLedgerFile(file);
    expect(verdict.ok).toBe(false);
  });

  it('refuses a file that is not SQLite, and a database that is not a ledger', async () => {
    const dir = tmpDir();
    const text = path.join(dir, 'notes.db');
    fs.writeFileSync(
      text,
      'this is not a database, just some text\n'.repeat(200),
    );
    expect((await checkLedgerFile(text)).ok).toBe(false);

    const other = path.join(dir, 'other.db');
    await makeLedger(other, 50, false);
    expect(await checkLedgerFile(other)).toMatchObject({
      ok: false,
      reason: 'not-a-ledger',
    });
  });

  it('opens an encrypted backup with the till key only', async () => {
    const dir = tmpDir();
    const plain = path.join(dir, 'plain.db');
    const enc = path.join(dir, 'enc.db');
    const key = 'ab'.repeat(32);
    await makeLedger(plain, 100);
    await encryptPlaintextSqlite({
      sourceFile: plain,
      destFile: enc,
      encryptionKey: key,
    });
    expect(await checkLedgerFile(enc, key)).toEqual({ ok: true });
    expect(await checkLedgerFile(enc)).toMatchObject({
      ok: false,
      reason: 'locked',
    });
    expect((await checkLedgerFile(enc, 'cd'.repeat(32))).ok).toBe(false);
  });
});
