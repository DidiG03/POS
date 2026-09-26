import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { disconnectPrisma, isSqliteLocked } from '@db/client';
import {
  lockVaultForTests,
  setupVaultWithOs,
  tryUnlockWithOs,
  unlockVault,
  bootstrapVault,
} from './lifecycle';
import { recoveryKeyToBytes, unwrapKey, wrapKey } from './crypto';
import { setOsVaultCryptoForTests, type OsVaultCrypto } from './osUnlock';
import { looksLikeSqliteCiphertext } from './sqliteCipher';

const FAST = { t: 1, m: 16, p: 1 };
const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-vault-'));
  dirs.push(dir);
  return dir;
}

function useOs() {
  setOsVaultCryptoForTests(memoryOsVault());
}

beforeEach(() => {
  lockVaultForTests();
  process.env.POS_VAULT = '1';
  process.env.POS_VAULT_LOCK = '1';
});

afterEach(async () => {
  await disconnectPrisma();
  lockVaultForTests();
  setOsVaultCryptoForTests(null);
  delete process.env.POS_VAULT;
  delete process.env.POS_VAULT_LOCK;
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function readUsers(dbFile: string, key: string) {
  const client = createClient({
    url: `file:${dbFile}`,
    encryptionKey: key,
  });
  try {
    return await client.execute('SELECT displayName FROM "User"');
  } finally {
    await client.close();
  }
}

describe('setupVaultWithOs / unlockVault', () => {
  it('reports the sqlite client as locked before unlock', () => {
    expect(isSqliteLocked()).toBe(true);
  });

  it('encrypts a plaintext ledger and reopens it with the recovery key', async () => {
    useOs();
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const src = createClient({ url: `file:${dbFile}` });
    await src.execute(
      'CREATE TABLE "User" (id INTEGER PRIMARY KEY, displayName TEXT)',
    );
    await src.execute(`INSERT INTO "User" (displayName) VALUES ('Ada')`);
    await src.close();

    const setup = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.recoveryKey).toMatch(/^[0-9A-F-]+$/);
    expect(fs.existsSync(path.join(dir, 'vault.json'))).toBe(true);
    expect(looksLikeSqliteCiphertext(dbFile)).toBe(true);

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'),
    );
    expect(written.passphrase).toBeUndefined();
    expect(written.unlockMode).toBe('os');

    lockVaultForTests();

    const wrong = await unlockVault('not-the-recovery-key', {
      userData: dir,
      dbFile,
      openPrisma: false,
    });
    expect(wrong).toEqual({ ok: false, error: 'wrong_secret' });

    const ok = await unlockVault(setup.recoveryKey!, {
      userData: dir,
      dbFile,
      openPrisma: false,
    });
    expect(ok).toEqual({ ok: true });

    const vault = JSON.parse(
      fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'),
    );
    const dek = await unwrapKey(
      recoveryKeyToBytes(setup.recoveryKey!)!,
      vault.recovery,
    );
    expect(dek).toBeTruthy();
    const rows = await readUsers(dbFile, dek!.toString('hex'));
    expect(rows.rows).toEqual([{ displayName: 'Ada' }]);
  });

  it('opens again from the OS wrap', async () => {
    useOs();
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const setup = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    expect(looksLikeSqliteCiphertext(dbFile)).toBe(true);
    lockVaultForTests();
    expect(
      await tryUnlockWithOs({ userData: dir, dbFile, openPrisma: false }),
    ).toBe(true);
  });

  it('opens an older till file once, then drops that wrap', async () => {
    useOs();
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const setup = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    const vaultPath = path.join(dir, 'vault.json');
    const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
    const dek = await unwrapKey(
      recoveryKeyToBytes(setup.recoveryKey!)!,
      vault.recovery,
    );
    const nfd = 'fjalëkalimi1'.normalize('NFD');
    vault.passphrase = await wrapKey(nfd, dek!, FAST);
    vault.unlockMode = 'passphrase';
    delete vault.os;
    fs.writeFileSync(vaultPath, `${JSON.stringify(vault, null, 2)}\n`);
    lockVaultForTests();

    expect(
      await tryUnlockWithOs({ userData: dir, dbFile, openPrisma: false }),
    ).toBe(false);
    expect(
      await unlockVault('fjalëkalimi1'.normalize('NFC'), {
        userData: dir,
        dbFile,
        openPrisma: false,
      }),
    ).toEqual({ ok: true });

    const after = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
    expect(after.passphrase).toBeUndefined();
    expect(after.os?.blob).toBeTruthy();
    expect(after.unlockMode).toBe('os');

    lockVaultForTests();
    expect(
      await tryUnlockWithOs({ userData: dir, dbFile, openPrisma: false }),
    ).toBe(true);
    lockVaultForTests();
    expect(
      await unlockVault('fjalëkalimi1', {
        userData: dir,
        dbFile,
        openPrisma: false,
      }),
    ).toEqual({ ok: false, error: 'wrong_secret' });
  });

  it('still opens when vault.json cannot be rewritten after a correct recovery key', async () => {
    useOs();
    const dir = tmpDir();
    const dataDir = path.join(dir, 'data');
    const dbDir = path.join(dir, 'db');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(dbDir);
    const dbFile = path.join(dbDir, 'pos.db');
    const src = createClient({ url: `file:${dbFile}` });
    await src.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await src.close();
    const setup = await setupVaultWithOs({
      userData: dataDir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    lockVaultForTests();
    fs.chmodSync(dataDir, 0o555);
    try {
      expect(
        await unlockVault(setup.recoveryKey!, {
          userData: dataDir,
          dbFile,
          openPrisma: false,
        }),
      ).toEqual({ ok: true });
    } finally {
      fs.chmodSync(dataDir, 0o755);
    }
  });

  it('serializes overlapping unlocks of the same recovery key', async () => {
    useOs();
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const src = createClient({ url: `file:${dbFile}` });
    await src.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await src.close();
    const setup = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    lockVaultForTests();
    const [a, b] = await Promise.all([
      unlockVault(setup.recoveryKey!, {
        userData: dir,
        dbFile,
        openPrisma: false,
      }),
      unlockVault(setup.recoveryKey!, {
        userData: dir,
        dbFile,
        openPrisma: false,
      }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });

  it('does not keep vault.json when the database cannot be encrypted', async () => {
    useOs();
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    fs.writeFileSync(dbFile, 'not-sqlite');
    const setup = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(false);
    expect(setup).toMatchObject({ error: 'unlock_failed' });
    expect(fs.existsSync(path.join(dir, 'vault.json'))).toBe(false);
  });

  it('finishes encrypting if vault.json was left beside a plaintext ledger', async () => {
    useOs();
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const src = createClient({ url: `file:${dbFile}` });
    await src.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await src.close();
    const setup = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    lockVaultForTests();

    const vaultPath = path.join(dir, 'vault.json');
    const vaultJson = fs.readFileSync(vaultPath, 'utf8');
    const plain = path.join(dir, 'plain.db');
    const p = createClient({ url: `file:${plain}` });
    await p.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await p.close();
    fs.copyFileSync(plain, dbFile);
    fs.writeFileSync(vaultPath, vaultJson);

    const again = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(again.ok).toBe(true);
    expect(looksLikeSqliteCiphertext(dbFile)).toBe(true);
  });

  it('does not auto-create a vault before the owner encrypts the till', async () => {
    useOs();
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    await bootstrapVault({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(fs.existsSync(path.join(dir, 'vault.json'))).toBe(false);
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
