import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { disconnectPrisma, isSqliteLocked } from '@db/client';
import {
  lockVaultForTests,
  setVaultUnlockMode,
  setupVault,
  setupVaultWithOs,
  tryUnlockWithOs,
  unlockVault,
  bootstrapVault,
} from './lifecycle';
import { setOsVaultCryptoForTests, type OsVaultCrypto } from './osUnlock';
import { looksLikeSqliteCiphertext } from './sqliteCipher';

const FAST = { t: 1, m: 16, p: 1 };
const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-vault-'));
  dirs.push(dir);
  return dir;
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

describe('setupVault / unlockVault', () => {
  it('reports the sqlite client as locked before unlock', () => {
    expect(isSqliteLocked()).toBe(true);
  });

  it('encrypts a plaintext ledger and reopens it with the passphrase', async () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const src = createClient({ url: `file:${dbFile}` });
    await src.execute(
      'CREATE TABLE "User" (id INTEGER PRIMARY KEY, displayName TEXT)',
    );
    await src.execute(`INSERT INTO "User" (displayName) VALUES ('Ada')`);
    await src.close();

    const setup = await setupVault('kitchen-pass-1', {
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

    lockVaultForTests();

    const wrong = await unlockVault('not-the-passphrase', {
      userData: dir,
      dbFile,
      openPrisma: false,
    });
    expect(wrong).toEqual({ ok: false, error: 'wrong_secret' });

    const ok = await unlockVault('kitchen-pass-1', {
      userData: dir,
      dbFile,
      openPrisma: false,
    });
    expect(ok).toEqual({ ok: true });

    const vault = JSON.parse(
      fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'),
    );
    const { unwrapKey } = await import('./crypto');
    const dek = await unwrapKey('kitchen-pass-1', vault.passphrase);
    expect(dek).toBeTruthy();
    const rows = await readUsers(dbFile, dek!.toString('hex'));
    expect(rows.rows).toEqual([{ displayName: 'Ada' }]);
  });

  it('unlocks with the recovery key', async () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const src = createClient({ url: `file:${dbFile}` });
    await src.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await src.close();
    const setup = await setupVault('kitchen-pass-1', {
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true });
    if (!setup.ok) return;
    lockVaultForTests();
    const recovered = await unlockVault(setup.recoveryKey!, {
      userData: dir,
      dbFile,
      openPrisma: false,
    });
    expect(recovered).toEqual({ ok: true });
  });

  it('opens again from the OS wrap without a passphrase', async () => {
    const os = memoryOsVault();
    setOsVaultCryptoForTests(os);
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

  it('can require a passphrase at start after OS setup', async () => {
    setOsVaultCryptoForTests(memoryOsVault());
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const setup = await setupVaultWithOs({
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    const switched = await setVaultUnlockMode(
      { unlockMode: 'passphrase', passphrase: 'kitchen-pass-1' },
      { userData: dir, kdf: FAST },
    );
    expect(switched).toEqual({ ok: true });
    lockVaultForTests();
    expect(
      await tryUnlockWithOs({ userData: dir, dbFile, openPrisma: false }),
    ).toBe(false);
    expect(
      await unlockVault('kitchen-pass-1', {
        userData: dir,
        dbFile,
        openPrisma: false,
      }),
    ).toEqual({ ok: true });
  });

  it('opens a passphrase wrapped with trailing spaces or combining marks', async () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const nfd = 'fjalëkalimi1'.normalize('NFD');
    const setup = await setupVault(`  ${nfd}  `, {
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(setup.ok).toBe(true);
    lockVaultForTests();
    expect(
      await unlockVault('fjalëkalimi1'.normalize('NFC'), {
        userData: dir,
        dbFile,
        openPrisma: false,
      }),
    ).toEqual({ ok: true });
  });

  it('does not keep vault.json when the database cannot be encrypted', async () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    fs.writeFileSync(dbFile, 'not-sqlite');
    const setup = await setupVault('kitchen-pass-1', {
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
    const dir = tmpDir();
    const dbFile = path.join(dir, 'pos.db');
    const src = createClient({ url: `file:${dbFile}` });
    await src.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await src.close();
    const setup = await setupVault('kitchen-pass-1', {
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

    const again = await setupVault('kitchen-pass-1', {
      userData: dir,
      dbFile,
      kdf: FAST,
      openPrisma: false,
    });
    expect(again.ok).toBe(true);
    expect(looksLikeSqliteCiphertext(dbFile)).toBe(true);
  });

  it('does not auto-create an OS-only vault before the owner sets a passphrase', async () => {
    setOsVaultCryptoForTests(memoryOsVault());
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
