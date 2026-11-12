import { app } from 'electron';
import fs from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { getOpenSqliteMode, prisma } from '@db/client';
import { looksLikeSqliteCiphertext } from './vault/sqliteCipher';
import { checkLedgerFile } from './ledgerFileCheck';
import { openLedgerEncryptionKey } from './vault/lifecycle';

export async function getSqliteDbFilePath(): Promise<string | null> {
  try {
    const rows = (await (prisma as any).$queryRawUnsafe(
      'PRAGMA database_list;',
    )) as any[];
    const main = Array.isArray(rows)
      ? rows.find((r) => String(r?.name || r?.[1] || '') === 'main')
      : null;
    const file = String(main?.file ?? main?.[2] ?? '');
    if (!file) return null;
    return resolvePath(file);
  } catch {
    try {
      const u = String(process.env.DATABASE_URL || '').trim();
      if (u.startsWith('file:')) {
        const p = u.replace(/^file:/, '');
        return resolvePath(p);
      }
    } catch {
      // ignore
    }
    return null;
  }
}

function getBackupsDir(): string {
  return join(app.getPath('userData'), 'backups');
}

function ensureDir(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

function backupFileName(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `pos-backup-${y}${m}${d}-${hh}${mm}${ss}.db`;
}

export async function createDbBackupNow(): Promise<{
  ok: boolean;
  file?: string;
  error?: string;
}> {
  const dbPath = await getSqliteDbFilePath();
  if (!dbPath) return { ok: false, error: 'Could not locate database file' };
  const dir = getBackupsDir();
  ensureDir(dir);
  const dest = join(dir, backupFileName());

  try {
    try {
      await (prisma as any).$executeRawUnsafe(
        'PRAGMA wal_checkpoint(TRUNCATE);',
      );
    } catch {
      // ignore
    }

    // VACUUM INTO on an encrypted connection can emit a plaintext clone.
    let written = false;
    if (getOpenSqliteMode() !== 'encrypted') {
      try {
        await (prisma as any).$executeRawUnsafe(
          `VACUUM INTO '${dest.replace(/'/g, "''")}';`,
        );
        written = true;
      } catch {
        // fallback to file copy
      }
    }
    if (!written) fs.copyFileSync(dbPath, dest);

    // A backup nobody can restore is worse than none: it is read back and
    // checked before it is reported as made.
    const verdict = await checkLedgerFile(dest, openLedgerEncryptionKey());
    if (!verdict.ok) {
      try {
        fs.unlinkSync(dest);
      } catch {
        // leave it; it is reported as failed either way
      }
      return {
        ok: false,
        error: `The backup did not pass its check and was discarded. ${verdict.detail}`,
      };
    }
    return { ok: true, file: dest };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Backup failed') };
  }
}

export function listDbBackups(): Array<{
  file: string;
  name: string;
  bytes: number;
  createdAt: string;
}> {
  const dir = getBackupsDir();
  ensureDir(dir);
  const out: Array<{
    file: string;
    name: string;
    bytes: number;
    createdAt: string;
  }> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.db'))) {
    const file = join(dir, name);
    try {
      const st = fs.statSync(file);
      out.push({
        file,
        name,
        bytes: st.size,
        createdAt: st.mtime.toISOString(),
      });
    } catch {
      // ignore
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function restoreDbBackup(
  name: string,
): Promise<{ ok: boolean; error?: string; devRestartRequired?: boolean }> {
  const dir = getBackupsDir();
  ensureDir(dir);
  const safeName = String(name || '').replace(/[^0-9A-Za-z._-]/g, '');
  if (!safeName.endsWith('.db'))
    return { ok: false, error: 'Invalid backup file' };
  const src = join(dir, safeName);
  if (!fs.existsSync(src)) return { ok: false, error: 'Backup not found' };
  const dbPath = await getSqliteDbFilePath();
  if (!dbPath) return { ok: false, error: 'Could not locate database file' };
  // An encrypted backup cannot be opened once Disk protection is off.
  if (getOpenSqliteMode() === 'plain' && looksLikeSqliteCiphertext(src)) {
    return {
      ok: false,
      error:
        'This backup was made while Disk protection was on. Turn Disk protection on again to restore it.',
    };
  }

  // Checked before anything is touched: a damaged or cut-short file would
  // otherwise replace a working ledger and only fail at the next start.
  const verdict = await checkLedgerFile(src, openLedgerEncryptionKey());
  if (!verdict.ok) {
    return {
      ok: false,
      error: `This backup cannot be restored, so nothing was changed. ${verdict.detail}`,
    };
  }

  // The current ledger is overwritten next. Without a copy of it, restoring
  // the wrong file would lose every sale since that backup for good.
  const safety = await createDbBackupNow().catch((e: any) => ({
    ok: false,
    error: String(e?.message || e),
  }));
  if (!safety.ok) {
    return {
      ok: false,
      error:
        `Could not back up the current data first, so nothing was restored. ${safety.error || ''}`.trim(),
    };
  }

  try {
    await prisma.$disconnect().catch(() => null);
    fs.copyFileSync(src, dbPath);
    // The old ledger's -wal/-shm must not be replayed onto the restored file.
    for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.unlinkSync(side);
      } catch {
        // not there
      }
    }
    if (app.isPackaged) {
      app.relaunch();
      app.exit(0);
      return { ok: true };
    }
    setTimeout(() => app.exit(0), 250);
    return { ok: true, devRestartRequired: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Restore failed') };
  }
}
