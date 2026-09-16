import { app } from 'electron';
import fs from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { getOpenSqliteMode, prisma } from '@db/client';

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
    if (getOpenSqliteMode() !== 'encrypted') {
      try {
        await (prisma as any).$executeRawUnsafe(
          `VACUUM INTO '${dest.replace(/'/g, "''")}';`,
        );
        return { ok: true, file: dest };
      } catch {
        // fallback to file copy
      }
    }

    fs.copyFileSync(dbPath, dest);
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

  try {
    await createDbBackupNow().catch(() => null);
    await prisma.$disconnect().catch(() => null);
    fs.copyFileSync(src, dbPath);
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
