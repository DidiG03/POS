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
  wrapKey,
  type Argon2Params,
  type WrappedKey,
} from './crypto';
import { isOsUnlockAvailable, unwrapDekFromOs, wrapDekForOs } from './osUnlock';
import { secureDelete, secureDeleteSqliteGroup } from './secureDelete';
import {
  effectiveUnlockMode,
  readVaultFile,
  vaultFilePath,
  writeVaultFile,
  type VaultFile,
} from './store';
import {
  encryptPlaintextSqlite,
  isPlaintextSqlite,
  looksLikeSqliteCiphertext,
  openLibsql,
  verifyEncryptedSqlite,
} from './sqliteCipher';
import { replaceFile } from './replaceFile';

export type VaultState = 'disabled' | 'setup' | 'locked' | 'open' | 'broken';

export type VaultStatus = {
  state: VaultState;
  unlockMode?: 'os' | 'disabled';
  osAvailable?: boolean;
  recoveryKey?: string;
};

export type VaultPrefs = {
  state: VaultState;
  unlockMode: 'os' | 'disabled';
  osAvailable: boolean;
};

export type VaultActionResult =
  | { ok: true; recoveryKey?: string }
  | { ok: false; error: string };

let unlockedDek: Buffer | null = null;
let pendingRecoveryKey: string | null = null;
let vaultOp: Promise<unknown> = Promise.resolve();

function withVaultOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = vaultOp.then(fn, fn);
  vaultOp = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
    };
  }
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  const vault = readVaultFile(userData);
  const extras = {
    osAvailable,
    unlockMode: 'os' as const,
    recoveryKey: pendingRecoveryKey || undefined,
  };
  if (unlockedDek) return { state: 'open', ...extras };
  const encrypted = looksLikeSqliteCiphertext(dbFile);
  if (!vault && encrypted) return { state: 'broken', ...extras };
  if (!vault) return { state: 'setup', ...extras };
  return { state: 'locked', ...extras };
}

function persistVault(userData: string, vault: VaultFile, dek: Buffer): void {
  const osBlob = wrapDekForOs(dek) || vault.os?.blob;
  const next: VaultFile = {
    version: 2,
    recovery: vault.recovery,
    unlockMode: 'os',
    os: osBlob ? { provider: 'safeStorage', blob: osBlob } : undefined,
  };
  // Keep an older wrap only while this PC cannot store the key itself.
  if (!osBlob && vault.passphrase) {
    next.passphrase = vault.passphrase;
    next.unlockMode = 'passphrase';
  }
  writeVaultFile(userData, next);
}

/** Opens vault files written before the device secret was removed. */
async function unwrapLegacyWrap(
  secret: string,
  wrapped: WrappedKey,
): Promise<Buffer | null> {
  const raw = String(secret || '');
  const candidates = [
    raw.normalize('NFC').trim(),
    raw,
    raw.trim(),
    raw.normalize('NFD').trim(),
    raw.normalize('NFC'),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const dek = await unwrapKey(candidate, wrapped);
    if (dek) return dek;
  }
  return null;
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

function vaultOpError(e: unknown): string {
  const msg = String((e as Error)?.message || e || 'unlock_failed');
  console.error('[vault]', msg);
  return 'unlock_failed';
}

function discardIncompleteVault(userData: string, dbFile: string): void {
  try {
    fs.unlinkSync(vaultFilePath(userData));
  } catch {
    // ignore
  }
  secureDelete(`${dbFile}.encrypted-new`);
}

export async function setupVaultWithOs(opts?: {
  userData?: string;
  dbFile?: string;
  kdf?: Argon2Params;
  openPrisma?: boolean;
}): Promise<VaultActionResult> {
  return withVaultOp(() => setupVaultWithOsOp(opts));
}

async function setupVaultWithOsOp(opts?: {
  userData?: string;
  dbFile?: string;
  kdf?: Argon2Params;
  openPrisma?: boolean;
}): Promise<VaultActionResult> {
  if (!isOsUnlockAvailable()) return { ok: false, error: 'os_unavailable' };
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  if (readVaultFile(userData)) {
    if (looksLikeSqliteCiphertext(dbFile)) {
      return { ok: false, error: 'already_setup' };
    }
    discardIncompleteVault(userData, dbFile);
  }

  const dek = generateDek();
  const recoveryKey = generateRecoveryKey();
  const recoveryBytes = recoveryKeyToBytes(recoveryKey);
  if (!recoveryBytes) return { ok: false, error: 'recovery_failed' };
  const kdf = opts?.kdf ?? DEFAULT_KDF;
  const osBlob = wrapDekForOs(dek);
  if (!osBlob) return { ok: false, error: 'os_unavailable' };
  const vault: VaultFile = {
    version: 2,
    recovery: await wrapKey(recoveryBytes, dek, kdf),
    unlockMode: 'os',
    os: { provider: 'safeStorage', blob: osBlob },
  };

  try {
    await openWithDek(dbFile, dek, opts?.openPrisma !== false);
    writeVaultFile(userData, vault);
    shredPlaintextSidecars(userData, dbFile);
    pendingRecoveryKey = recoveryKey;
    return { ok: true, recoveryKey };
  } catch (e) {
    unlockedDek = null;
    discardIncompleteVault(userData, dbFile);
    return { ok: false, error: vaultOpError(e) };
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
  } catch {
    unlockedDek = null;
    return false;
  }
  try {
    persistVault(userData, vault, dek);
  } catch (e) {
    console.error('[vault] persist after unlock failed:', e);
  }
  return true;
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
  // A missing vault stays on the setup screen until the owner encrypts it.
}

export async function unlockVault(
  secret: string,
  opts?: { userData?: string; dbFile?: string; openPrisma?: boolean },
): Promise<VaultActionResult> {
  return withVaultOp(() => unlockVaultOp(secret, opts));
}

async function unlockVaultOp(
  secret: string,
  opts?: { userData?: string; dbFile?: string; openPrisma?: boolean },
): Promise<VaultActionResult> {
  if (unlockedDek) return { ok: true };
  const userData = opts?.userData ?? vaultUserData();
  const dbFile = opts?.dbFile ?? resolveSqliteFilePath();
  const vault = readVaultFile(userData);
  if (!vault) return { ok: false, error: 'missing_vault' };

  let recoveryDek: Buffer | null = null;
  try {
    const recoveryBytes = recoveryKeyToBytes(secret);
    recoveryDek = recoveryBytes
      ? await unwrapKey(recoveryBytes, vault.recovery)
      : null;
  } catch (e) {
    console.error('[vault] recovery unwrap failed:', e);
  }
  let legacyDek: Buffer | null = null;
  if (!recoveryDek && vault.passphrase) {
    try {
      legacyDek = await unwrapLegacyWrap(secret, vault.passphrase);
    } catch (e) {
      console.error('[vault] legacy unwrap failed:', e);
    }
  }
  const dek = recoveryDek || legacyDek;
  if (!dek) return { ok: false, error: 'wrong_secret' };

  try {
    await openWithDek(dbFile, dek, opts?.openPrisma !== false);
  } catch (e) {
    unlockedDek = null;
    return { ok: false, error: vaultOpError(e) };
  }
  try {
    persistVault(userData, vault, dek);
  } catch (e) {
    // The ledger is already open. Rewriting vault.json (OS Keychain wrap)
    // must not send the owner back to "could not open the till".
    console.error('[vault] persist after unlock failed:', e);
  }
  return { ok: true };
}

export async function setVaultUnlockMode(opts?: {
  userData?: string;
}): Promise<VaultActionResult> {
  if (!unlockedDek) return { ok: false, error: 'locked' };
  if (!isOsUnlockAvailable()) return { ok: false, error: 'os_unavailable' };
  const userData = opts?.userData ?? vaultUserData();
  const vault = readVaultFile(userData);
  if (!vault) return { ok: false, error: 'missing_vault' };
  persistVault(userData, vault, unlockedDek);
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
    try {
      fs.unlinkSync(dbFile);
    } catch {
      // Windows may still hold the plaintext; replaceFile copies over it.
    }
  }
  secureDelete(`${dbFile}-wal`);
  secureDelete(`${dbFile}-shm`);
  replaceFile(dest, dbFile);
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
  for (const folder of ['one-tap-pos', 'OneTap POS', 'one-tap-pos']) {
    const leftover = path.join(appData, folder, 'db', 'pos.db');
    if (path.resolve(leftover) === current) continue;
    if (isPlaintextSqlite(leftover)) secureDeleteSqliteGroup(leftover);
  }
}
