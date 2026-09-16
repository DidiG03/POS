import fs from 'node:fs';
import path from 'node:path';
import { openEncryptedSqlite, resolveSqliteFilePath } from '@db/client';
import {
  DEFAULT_KDF,
  dekToEncryptionKey,
  generateDek,
  generateRecoveryKey,
  recoveryKeyToBytes,
  unwrapKey,
  validatePassphrase,
  wrapKey,
  type Argon2Params,
} from './crypto';
import { isOsUnlockAvailable, unwrapDekFromOs, wrapDekForOs } from './osUnlock';
import { secureDelete, secureDeleteSqliteGroup } from './secureDelete';
import {
  effectiveUnlockMode,
  readVaultFile,
  writeVaultFile,
  type VaultFile,
  type VaultUnlockMode,
} from './store';
import {
  encryptPlaintextSqlite,
  isPlaintextSqlite,
  looksLikeSqliteCiphertext,
  openLibsql,
  verifyEncryptedSqlite,
} from './sqliteCipher';

export type VaultState = 'disabled' | 'setup' | 'locked' | 'open' | 'broken';

export type VaultStatus = {
  state: VaultState;
  unlockMode?: VaultUnlockMode | 'disabled';
  osAvailable?: boolean;
  hasPassphrase?: boolean;
  recoveryKey?: string;
};

export type VaultPrefs = {
  state: VaultState;
  unlockMode: VaultUnlockMode | 'disabled';
  osAvailable: boolean;
  hasPassphrase: boolean;
};

export type VaultActionResult =
  | { ok: true; recoveryKey?: string }
  | { ok: false; error: string };

let unlockedDek: Buffer | null = null;
let pendingRecoveryKey: string | null = null;

export function isVaultOpen(): boolean {
  return unlockedDek != null;
}

export function isVaultRequired(): boolean {
  const flag = String(process.env.POS_VAULT || '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  return false;
}

export function vaultUserData(): string {
  const fromEnv = String(process.env.POS_USER_DATA || '').trim();
  if (fromEnv) return fromEnv;
  return process.cwd();
}

export function peekPendingRecoveryKey(): string | null {
  return pendingRecoveryKey;
}

export function ackPendingRecoveryKey(): void {
  pendingRecoveryKey = null;
}

export function getVaultPrefs(opts?: {
  userData?: string;
  dbFile?: string;
}): VaultPrefs {
  const status = getVaultStatus(opts);
  return {
    state: status.state,
    unlockMode: status.unlockMode || 'disabled',
    osAvailable: Boolean(status.osAvailable),
    hasPassphrase: Boolean(status.hasPassphrase),
  };
}

export function getVaultStatus(opts?: {
  userData?: string;
  dbFile?: string;
}): VaultStatus {
  const osAvailable = isOsUnlockAvailable();
  if (!isVaultRequired()) {
    return {
      state: 'disabled',
      unlockMode: 'disabled',
      osAvailable,
      hasPassphrase: false,
    };
  }
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  const vault = readVaultFile(userData);
  const extras = {
    osAvailable,
    hasPassphrase: Boolean(vault?.passphrase),
    unlockMode: (vault ? effectiveUnlockMode(vault) : 'os') as
      | VaultUnlockMode
      | 'disabled',
    recoveryKey: pendingRecoveryKey || undefined,
  };
  if (unlockedDek) return { state: 'open', ...extras };
  const encrypted = looksLikeSqliteCiphertext(dbFile);
  if (!vault && encrypted) return { state: 'broken', ...extras };
  if (!vault) return { state: 'setup', ...extras };
  return { state: 'locked', ...extras };
}

function persistVault(
  userData: string,
  vault: VaultFile,
  dek: Buffer,
  unlockMode: VaultUnlockMode,
): void {
  const osBlob =
    unlockMode === 'os' ? wrapDekForOs(dek) || vault.os?.blob : undefined;
  writeVaultFile(userData, {
    version: 2,
    passphrase: vault.passphrase,
    recovery: vault.recovery,
    unlockMode,
    os:
      unlockMode === 'os' && osBlob
        ? { provider: 'safeStorage', blob: osBlob }
        : undefined,
  });
}

async function openWithDek(
  dbFile: string,
  dek: Buffer,
  openPrisma: boolean,
): Promise<void> {
  await materializeEncryptedDb(dbFile, dekToEncryptionKey(dek));
  if (openPrisma) {
    await openEncryptedSqlite(dbFile, dekToEncryptionKey(dek));
  }
  unlockedDek = dek;
}

export async function setupVault(
  passphrase: string,
  opts?: {
    userData?: string;
    dbFile?: string;
    kdf?: Argon2Params;
    openPrisma?: boolean;
  },
): Promise<VaultActionResult> {
  const check = validatePassphrase(passphrase);
  if (!check.ok) return { ok: false, error: check.error };
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  if (readVaultFile(userData)) return { ok: false, error: 'already_setup' };

  const dek = generateDek();
  const recoveryKey = generateRecoveryKey();
  const recoveryBytes = recoveryKeyToBytes(recoveryKey);
  if (!recoveryBytes) return { ok: false, error: 'recovery_failed' };
  const kdf = opts?.kdf ?? DEFAULT_KDF;
  const vault: VaultFile = {
    version: 2,
    passphrase: await wrapKey(passphrase, dek, kdf),
    recovery: await wrapKey(recoveryBytes, dek, kdf),
    unlockMode: isOsUnlockAvailable() ? 'os' : 'passphrase',
  };
  persistVault(userData, vault, dek, vault.unlockMode || 'passphrase');

  try {
    await openWithDek(dbFile, dek, opts?.openPrisma !== false);
    shredPlaintextSidecars(userData, dbFile);
    pendingRecoveryKey = recoveryKey;
    return { ok: true, recoveryKey };
  } catch (e) {
    unlockedDek = null;
    return {
      ok: false,
      error: String((e as Error)?.message || e || 'setup_failed'),
    };
  }
}

export async function setupVaultWithOs(opts?: {
  userData?: string;
  dbFile?: string;
  kdf?: Argon2Params;
  openPrisma?: boolean;
}): Promise<VaultActionResult> {
  if (!isOsUnlockAvailable()) return { ok: false, error: 'os_unavailable' };
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  if (readVaultFile(userData)) return { ok: false, error: 'already_setup' };

  const dek = generateDek();
  const recoveryKey = generateRecoveryKey();
  const recoveryBytes = recoveryKeyToBytes(recoveryKey);
  if (!recoveryBytes) return { ok: false, error: 'recovery_failed' };
  const kdf = opts?.kdf ?? DEFAULT_KDF;
  const osBlob = wrapDekForOs(dek);
  if (!osBlob) return { ok: false, error: 'os_unavailable' };
  writeVaultFile(userData, {
    version: 2,
    recovery: await wrapKey(recoveryBytes, dek, kdf),
    unlockMode: 'os',
    os: { provider: 'safeStorage', blob: osBlob },
  });

  try {
    await openWithDek(dbFile, dek, opts?.openPrisma !== false);
    shredPlaintextSidecars(userData, dbFile);
    pendingRecoveryKey = recoveryKey;
    return { ok: true, recoveryKey };
  } catch (e) {
    unlockedDek = null;
    return {
      ok: false,
      error: String((e as Error)?.message || e || 'setup_failed'),
    };
  }
}

export async function tryUnlockWithOs(opts?: {
  userData?: string;
  dbFile?: string;
  openPrisma?: boolean;
}): Promise<boolean> {
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  const vault = readVaultFile(userData);
  if (!vault || effectiveUnlockMode(vault) !== 'os' || !vault.os?.blob) {
    return false;
  }
  const dek = unwrapDekFromOs(vault.os.blob);
  if (!dek) return false;
  try {
    await openWithDek(dbFile, dek, opts?.openPrisma !== false);
    return true;
  } catch {
    unlockedDek = null;
    return false;
  }
}

export async function bootstrapVault(opts?: {
  userData?: string;
  dbFile?: string;
  kdf?: Argon2Params;
  openPrisma?: boolean;
}): Promise<void> {
  if (!isVaultRequired()) return;
  if (unlockedDek) return;
  if (await tryUnlockWithOs(opts)) return;
  const userData = opts?.userData ?? vaultUserData();
  if (readVaultFile(userData)) return;
  if (!isOsUnlockAvailable()) return;
  await setupVaultWithOs(opts);
}

export async function unlockVault(
  secret: string,
  opts?: { userData?: string; dbFile?: string; openPrisma?: boolean },
): Promise<VaultActionResult> {
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  const vault = readVaultFile(userData);
  if (!vault) return { ok: false, error: 'missing_vault' };

  const passphraseDek = vault.passphrase
    ? await unwrapKey(secret, vault.passphrase)
    : null;
  const recoveryBytes = recoveryKeyToBytes(secret);
  const recoveryDek = recoveryBytes
    ? await unwrapKey(recoveryBytes, vault.recovery)
    : null;
  const dek = passphraseDek || recoveryDek;
  if (!dek) return { ok: false, error: 'wrong_secret' };

  try {
    await openWithDek(dbFile, dek, opts?.openPrisma !== false);
    persistVault(userData, vault, dek, effectiveUnlockMode(vault));
    return { ok: true };
  } catch (e) {
    unlockedDek = null;
    return {
      ok: false,
      error: String((e as Error)?.message || e || 'unlock_failed'),
    };
  }
}

export async function setVaultUnlockMode(
  input: { unlockMode: VaultUnlockMode; passphrase?: string },
  opts?: { userData?: string; kdf?: Argon2Params },
): Promise<VaultActionResult> {
  if (!unlockedDek) return { ok: false, error: 'locked' };
  const userData = opts?.userData ?? vaultUserData();
  const vault = readVaultFile(userData);
  if (!vault) return { ok: false, error: 'missing_vault' };
  const mode = input.unlockMode;
  if (mode === 'os') {
    if (!isOsUnlockAvailable()) return { ok: false, error: 'os_unavailable' };
    persistVault(userData, vault, unlockedDek, 'os');
    return { ok: true };
  }
  let next: VaultFile = vault;
  if (!vault.passphrase) {
    const check = validatePassphrase(String(input.passphrase || ''));
    if (!check.ok) return { ok: false, error: check.error };
    next = {
      ...vault,
      passphrase: await wrapKey(
        String(input.passphrase),
        unlockedDek,
        opts?.kdf ?? DEFAULT_KDF,
      ),
    };
  } else if (input.passphrase) {
    const check = validatePassphrase(input.passphrase);
    if (!check.ok) return { ok: false, error: check.error };
    next = {
      ...vault,
      passphrase: await wrapKey(
        input.passphrase,
        unlockedDek,
        opts?.kdf ?? DEFAULT_KDF,
      ),
    };
  }
  persistVault(userData, next, unlockedDek, 'passphrase');
  return { ok: true };
}

export function lockVaultForTests(): void {
  unlockedDek = null;
  pendingRecoveryKey = null;
}

async function materializeEncryptedDb(
  dbFile: string,
  encryptionKey: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  if (looksLikeSqliteCiphertext(dbFile)) {
    const ok = await verifyEncryptedSqlite(dbFile, encryptionKey);
    if (!ok) throw new Error('Encrypted database does not match this vault');
    return;
  }

  if (!fs.existsSync(dbFile) || fs.statSync(dbFile).size === 0) {
    try {
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    } catch {
      // ignore
    }
    const client = openLibsql(dbFile, encryptionKey);
    try {
      await client.execute(
        'CREATE TABLE IF NOT EXISTS _vault_init (id INTEGER PRIMARY KEY)',
      );
      await client.execute('DROP TABLE IF EXISTS _vault_init');
    } finally {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    return;
  }

  if (!isPlaintextSqlite(dbFile)) {
    throw new Error('Database file is not a readable SQLite database');
  }

  const dest = `${dbFile}.encrypted-new`;
  await encryptPlaintextSqlite({
    sourceFile: dbFile,
    destFile: dest,
    encryptionKey,
  });
  const ok = await verifyEncryptedSqlite(dest, encryptionKey);
  if (!ok) {
    secureDelete(dest);
    throw new Error('Failed to verify encrypted copy');
  }

  const leftover = `${dbFile}.plaintext-old`;
  try {
    if (fs.existsSync(leftover)) secureDelete(leftover);
    fs.renameSync(dbFile, leftover);
  } catch {
    fs.copyFileSync(dbFile, leftover);
  }
  secureDelete(`${dbFile}-wal`);
  secureDelete(`${dbFile}-shm`);
  fs.renameSync(dest, dbFile);
  secureDeleteSqliteGroup(leftover);
}

/** Old plaintext clones would undo encryption if left next to the live DB. */
function shredPlaintextSidecars(userData: string, dbFile: string): void {
  const backups = path.join(userData, 'backups');
  try {
    if (fs.existsSync(backups)) {
      for (const name of fs.readdirSync(backups)) {
        if (!name.endsWith('.db')) continue;
        const file = path.join(backups, name);
        if (isPlaintextSqlite(file)) secureDeleteSqliteGroup(file);
      }
    }
  } catch {
    // ignore
  }

  const appData = String(process.env.POS_APP_DATA || '').trim();
  if (!appData) return;
  const current = path.resolve(dbFile);
  for (const folder of ['code-orbit-pos', 'Code Orbit POS', 'codeorbit-pos']) {
    const leftover = path.join(appData, folder, 'db', 'pos.db');
    if (path.resolve(leftover) === current) continue;
    if (isPlaintextSqlite(leftover)) secureDeleteSqliteGroup(leftover);
  }
}
