/**
 * "Check & repair" and "Turn off Disk protection" on real files: an
 * encrypted ledger opened through Prisma, rebuilt or decrypted, and opened
 * again by the right engine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { disconnectPrisma, getOpenSqliteMode, prisma } from '@db/client';
import {
  disableDiskProtection,
  enableDiskProtectionOnRestart,
  getVaultPrefs,
  lockVaultForTests,
  repairLedger,
  setupVaultWithOs,
} from './lifecycle';
import { setOsVaultCryptoForTests, type OsVaultCrypto } from './osUnlock';
import { isPlaintextSqlite, looksLikeSqliteCiphertext } from './sqliteCipher';
import { isDiskProtectionOff } from './protectionOff';

const FAST = { t: 1, m: 16, p: 1 };
const dirs: string[] = [];
const PAID_AT_MS = Date.UTC(2026, 8, 29, 22, 55, 37, 894);

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-vault-maint-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  lockVaultForTests();
  setOsVaultCryptoForTests(memoryOsVault());
  process.env.POS_VAULT = '1';
  process.env.POS_VAULT_LOCK = '1';
});

afterEach(async () => {
  await disconnectPrisma();
  lockVaultForTests();
  setOsVaultCryptoForTests(null);
  delete process.env.POS_VAULT;
  delete process.env.POS_VAULT_LOCK;
  delete process.env.DATABASE_URL;
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A small plain ledger with a DATETIME column, then encrypted and opened. */
async function encryptedTill() {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'pos.db');
  process.env.DATABASE_URL = `file:${dbFile}`;
  const src = createClient({ url: `file:${dbFile}` });
  await src.execute(
    'CREATE TABLE "SyncState" ("key" TEXT PRIMARY KEY, "valueJson" TEXT, "updatedAt" DATETIME)',
  );
  await src.execute(
    'CREATE TABLE "Sale" (id INTEGER PRIMARY KEY AUTOINCREMENT, total REAL, "paidAt" DATETIME)',
  );
  for (let i = 0; i < 250; i++) {
    await src.execute({
      sql: 'INSERT INTO "Sale" (total, "paidAt") VALUES (?, ?)',
      args: [100 + i, PAID_AT_MS + i],
    });
  }
  await src.execute({
    sql: `INSERT INTO "SyncState" ("key", "valueJson", "updatedAt") VALUES ('settings', ?, ?)`,
    args: [JSON.stringify({ currency: 'ALL' }), PAID_AT_MS],
  });
  src.close();

  const setup = await setupVaultWithOs({ userData: dir, dbFile, kdf: FAST });
  expect(setup.ok).toBe(true);
  expect(getOpenSqliteMode()).toBe('encrypted');
  return { dir, dbFile };
}

describe('repairLedger', () => {
  it('rebuilds an encrypted ledger, keeps every row and the old file', async () => {
    const { dir, dbFile } = await encryptedTill();

    const r = await repairLedger({ dbFile });
    expect(r).toMatchObject({ ok: true, issuesFound: false, rows: 251 });
    if (!r.ok) return;

    expect(getOpenSqliteMode()).toBe('encrypted');
    expect(looksLikeSqliteCiphertext(dbFile)).toBe(true);
    expect(fs.existsSync(path.join(dir, r.backupFile))).toBe(true);
    expect(fs.existsSync(`${dbFile}.repair-new`)).toBe(false);

    // Writes work again through Prisma after the swap.
    await prisma.$executeRawUnsafe(
      `UPDATE "SyncState" SET "valueJson" = '{"currency":"EUR"}' WHERE "key" = 'settings'`,
    );
    const rows = (await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS n FROM "Sale"',
    )) as Array<{ n: number | bigint }>;
    expect(Number(rows[0].n)).toBe(250);
  });

  it('leaves the ledger untouched and open when the copy cannot be made', async () => {
    const { dbFile } = await encryptedTill();
    const before = fs.readFileSync(dbFile);
    // A directory where the copy must go makes the rebuild fail.
    fs.mkdirSync(`${dbFile}.repair-new`);

    const r = await repairLedger({ dbFile });
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(dbFile).equals(before)).toBe(true);
    expect(getOpenSqliteMode()).toBe('encrypted');
  });
});

describe('disableDiskProtection', () => {
  it('decrypts to a plain ledger the native engine can use, and stays off', async () => {
    const { dir, dbFile } = await encryptedTill();

    const r = await disableDiskProtection({ userData: dir, dbFile });
    expect(r).toMatchObject({ ok: true, rows: 251 });
    if (!r.ok) return;

    expect(isPlaintextSqlite(dbFile)).toBe(true);
    expect(getOpenSqliteMode()).toBe('plain');
    expect(isDiskProtectionOff(dir)).toBe(true);
    expect(process.env.POS_VAULT).toBe('0');
    expect(fs.existsSync(path.join(dir, 'vault.json'))).toBe(false);
    // The encrypted file and the vault that opens it are both kept.
    expect(looksLikeSqliteCiphertext(path.join(dir, r.backupFile))).toBe(true);
    expect(
      fs.readdirSync(dir).some((n) => /^vault-backup-.*\.json$/.test(n)),
    ).toBe(true);
    expect(getVaultPrefs({ userData: dir, dbFile })).toMatchObject({
      state: 'disabled',
      protectionOff: true,
      ledger: 'plain',
    });

    // DateTimes are back to the native engine's INTEGER milliseconds, exact.
    const plain = createClient({ url: `file:${dbFile}` });
    try {
      const first = await plain.execute(
        'SELECT typeof("paidAt") AS t, "paidAt" AS v FROM "Sale" ORDER BY id LIMIT 1',
      );
      expect(first.rows[0]).toMatchObject({ t: 'integer', v: PAID_AT_MS });
      const marker = await plain.execute(
        `SELECT COUNT(*) AS n FROM "SyncState" WHERE "key" = 'db:datetimeText'`,
      );
      expect(Number(marker.rows[0].n)).toBe(0);
    } finally {
      plain.close();
    }

    // And the live plain connection can save settings.
    await prisma.$executeRawUnsafe(
      `UPDATE "SyncState" SET "valueJson" = '{"currency":"EUR"}' WHERE "key" = 'settings'`,
    );

    expect(enableDiskProtectionOnRestart({ userData: dir })).toEqual({
      ok: true,
      restartRequired: true,
    });
    expect(isDiskProtectionOff(dir)).toBe(false);
  });

  it('refuses when the ledger is not encrypted', async () => {
    const dir = tmpDir();
    const r = await disableDiskProtection({
      userData: dir,
      dbFile: path.join(dir, 'pos.db'),
    });
    expect(r).toEqual({ ok: false, error: 'not_encrypted' });
  });
});

function memoryOsVault(): OsVaultCrypto {
  const key = Buffer.alloc(32, 9);
  return {
    isAvailable: () => true,
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, enc, tag]).toString('base64');
    },
    decrypt(blob) {
      const buf = Buffer.from(blob, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(buf.length - 16);
      const ct = buf.subarray(12, buf.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}
