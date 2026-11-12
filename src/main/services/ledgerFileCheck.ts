/**
 * Is this file a sound copy of the till's ledger?
 *
 * A backup was written and trusted unseen, and a restore copied whatever
 * file was named over the live ledger and restarted. A backup cut short by
 * a full disk, or damaged since, was only discovered when the till failed
 * to open after the restore, with the safety copy as the only way back.
 *
 * The file is opened read-only in effect (nothing is written to its
 * tables), SQLite's own integrity check is run over it, and it must hold
 * the staff table every ledger has.
 */
import fs from 'node:fs';
import {
  looksLikeSqliteCiphertext,
  openLibsql,
  sqliteIntegrityCheck,
} from './vault/sqliteCipher';

export type LedgerFileVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'empty'
        | 'locked'
        | 'unreadable'
        | 'damaged'
        | 'not-a-ledger';
      detail: string;
    };

function removeSidecars(file: string): void {
  // Opening a WAL-mode file leaves these beside it.
  for (const side of [`${file}-wal`, `${file}-shm`]) {
    try {
      fs.unlinkSync(side);
    } catch {
      // not there
    }
  }
}

async function hasStaffTable(file: string, key?: string): Promise<boolean> {
  const client = openLibsql(file, key);
  try {
    const r = await client.execute(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'User'`,
    );
    return r.rows.length > 0;
  } finally {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
}

/**
 * `encryptionKey`: the open ledger's key, needed when the file is an
 * encrypted backup. Without it an encrypted file is reported as `locked`.
 */
export async function checkLedgerFile(
  file: string,
  encryptionKey?: string | null,
): Promise<LedgerFileVerdict> {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { ok: false, reason: 'missing', detail: 'The file is not there.' };
  }
  if (size === 0) {
    return { ok: false, reason: 'empty', detail: 'The file is empty.' };
  }
  const encrypted = looksLikeSqliteCiphertext(file);
  if (encrypted && !encryptionKey) {
    return {
      ok: false,
      reason: 'locked',
      detail: 'The file is encrypted and this till cannot open it now.',
    };
  }
  const key = encrypted ? (encryptionKey ?? undefined) : undefined;
  const hadSidecars =
    fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`);
  try {
    let problems: string[];
    try {
      problems = await sqliteIntegrityCheck(file, key);
    } catch (e) {
      return {
        ok: false,
        reason: 'unreadable',
        detail: `The file could not be read as a ledger (${String((e as { message?: unknown })?.message || e).slice(0, 160)}).`,
      };
    }
    const bad = problems.filter((p) => p && p.toLowerCase() !== 'ok');
    if (bad.length > 0) {
      return {
        ok: false,
        reason: 'damaged',
        detail: `The file is damaged: ${bad.slice(0, 3).join('; ').slice(0, 300)}`,
      };
    }
    if (!(await hasStaffTable(file, key).catch(() => false))) {
      return {
        ok: false,
        reason: 'not-a-ledger',
        detail: 'The file is not a OneTap ledger.',
      };
    }
    return { ok: true };
  } finally {
    if (!hadSidecars) removeSidecars(file);
  }
}
