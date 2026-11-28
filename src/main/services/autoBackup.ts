/**
 * Automatic backups (off unless an admin switches them on).
 *
 * When on: a backup on every Z close and every N hours (default 6),
 * written with SQLite's VACUUM INTO (`createDbBackupNow`), read back and
 * checked (integrity_check), copied to a chosen folder (a USB stick or a
 * network / synced folder) and checked again there, and the newest N kept
 * (default 30) in each place. It runs in the background: a payment never
 * waits on it. If the last good backup is more than a day old, or the last
 * one failed, till health says so (and admins are told once a day).
 */
import fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { prisma } from '@db/client';
import { copyBackupTo, createDbBackupNow, getBackupsDir } from './dbBackups';
import { coreServices } from './core';
import { notifyAdminsAndActor } from './adminAlerts';
import { logIgnored } from './logIgnored';

export const AUTO_BACKUP_STATUS_KEY = 'backups:auto:last';
export const AUTO_BACKUP_PREFIX = 'pos-auto';
export const AUTO_BACKUP_STALE_MS = 24 * 60 * 60 * 1000;

export interface AutoBackupConfig {
  enabled: boolean;
  onZ: boolean;
  everyHours: number;
  /** Where copies go besides the till's own disk; '' = the till only. */
  folder: string;
  keep: number;
}

export interface AutoBackupStatus {
  /** Last attempt. */
  at: string;
  ok: boolean;
  reason: 'z' | 'schedule' | 'manual';
  error?: string;
  file?: string;
  copied?: string;
  /** Last attempt that fully succeeded. */
  lastOkAt?: string;
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

/** The settings, with defaults. Off unless switched on. */
export function autoBackupConfig(settings: any): AutoBackupConfig {
  const b = settings?.backups || {};
  return {
    enabled: b.auto === true,
    onZ: b.onZ !== false,
    everyHours: clamp(b.everyHours, 1, 24, 6),
    folder: String(b.folder || '').trim(),
    keep: clamp(b.keep, 1, 365, 30),
  };
}

/** True when a scheduled backup is due. */
export function scheduledBackupDue(input: {
  config: AutoBackupConfig;
  lastOkAt?: string | null;
  lastAttemptAt?: string | null;
  now: number;
}): boolean {
  if (!input.config.enabled) return false;
  const every = input.config.everyHours * 60 * 60 * 1000;
  const lastOk = Date.parse(String(input.lastOkAt || ''));
  if (!Number.isFinite(lastOk)) {
    // Never made: try now, but not more than every 15 minutes after a failure.
    const tried = Date.parse(String(input.lastAttemptAt || ''));
    return !Number.isFinite(tried) || input.now - tried >= 15 * 60_000;
  }
  if (input.now - lastOk < every) return false;
  const tried = Date.parse(String(input.lastAttemptAt || ''));
  return (
    !Number.isFinite(tried) ||
    tried <= lastOk ||
    input.now - tried >= 15 * 60_000
  );
}

/** The newest `keep` automatic backups stay; the file names to delete. */
export function backupsToPrune(names: string[], keep: number): string[] {
  return names
    .filter((n) => n.startsWith(`${AUTO_BACKUP_PREFIX}-`) && n.endsWith('.db'))
    .sort()
    .reverse()
    .slice(Math.max(0, keep));
}

/** Till-health warning text, or null. */
export function autoBackupWarning(input: {
  config: AutoBackupConfig;
  status: AutoBackupStatus | null;
  now: number;
}): string | null {
  if (!input.config.enabled) return null;
  const s = input.status;
  if (s && !s.ok) {
    return `The last automatic backup failed: ${s.error || 'unknown error'}. Check the backup folder in Settings › Backups.`;
  }
  const lastOk = Date.parse(String(s?.lastOkAt || ''));
  // None yet: the first runs within minutes of switching them on.
  if (!Number.isFinite(lastOk)) return null;
  if (input.now - lastOk >= AUTO_BACKUP_STALE_MS) {
    const hours = Math.floor((input.now - lastOk) / 3_600_000);
    return `No automatic backup has succeeded for ${hours} hours. Check Settings › Backups.`;
  }
  return null;
}

/** Problem with a backup folder, or null. */
export function backupFolderProblem(folder: string): string | null {
  if (!folder) return null;
  if (!isAbsolute(folder)) return `"${folder}" is not a full folder path.`;
  try {
    const st = fs.statSync(folder);
    if (!st.isDirectory()) return `"${folder}" is not a folder.`;
    fs.accessSync(folder, fs.constants.W_OK);
  } catch {
    return `The backup folder "${folder}" cannot be reached or written to (is the USB stick or network folder connected?).`;
  }
  return null;
}

function prune(dir: string, keep: number): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of backupsToPrune(names, keep)) {
    try {
      fs.unlinkSync(join(dir, n));
    } catch {
      // the next run tries again
    }
  }
}

export async function readAutoBackupStatus(): Promise<AutoBackupStatus | null> {
  const row = await prisma.syncState
    .findUnique({ where: { key: AUTO_BACKUP_STATUS_KEY } })
    .catch(logIgnored('autoBackup:read', null));
  const v = (row as any)?.valueJson;
  return v && typeof v.at === 'string' ? (v as AutoBackupStatus) : null;
}

async function writeStatus(status: AutoBackupStatus): Promise<void> {
  await prisma.syncState
    .upsert({
      where: { key: AUTO_BACKUP_STATUS_KEY },
      create: { key: AUTO_BACKUP_STATUS_KEY, valueJson: status as any },
      update: { valueJson: status as any },
    })
    .catch(logIgnored('autoBackup:write', undefined));
}

let running: Promise<AutoBackupStatus | null> | null = null;

/**
 * One automatic backup, if switched on (or `force` for "Back up now" of the
 * automatic kind). At most one at a time; a second call joins the first.
 */
export function runAutoBackup(
  reason: AutoBackupStatus['reason'],
  opts: { force?: boolean } = {},
): Promise<AutoBackupStatus | null> {
  if (running) return running;
  running = (async () => {
    const settings: any = await coreServices.readSettings();
    const config = autoBackupConfig(settings);
    if (!config.enabled && !opts.force) return null;
    if (reason === 'z' && !config.onZ && !opts.force) return null;
    const previous = await readAutoBackupStatus();
    const at = new Date().toISOString();
    const fail = async (error: string): Promise<AutoBackupStatus> => {
      const status: AutoBackupStatus = {
        at,
        ok: false,
        reason,
        error,
        lastOkAt: previous?.lastOkAt,
      };
      await writeStatus(status);
      // Once per failure streak, not every run.
      if (previous?.ok !== false) {
        await notifyAdminsAndActor({
          message: `Automatic backup failed: ${error}`,
          type: 'SECURITY',
        }).catch(logIgnored('autoBackup:notify', undefined));
      }
      return status;
    };
    const folderProblem = backupFolderProblem(config.folder);
    if (folderProblem) return fail(folderProblem);
    const made = await createDbBackupNow({ prefix: AUTO_BACKUP_PREFIX });
    if (!made.ok || !made.file) return fail(made.error || 'Backup failed.');
    let copied: string | undefined;
    if (config.folder) {
      const copy = await copyBackupTo(made.file, config.folder);
      if (!copy.ok) return fail(copy.error || 'Copy failed.');
      copied = copy.file;
      prune(config.folder, config.keep);
    }
    prune(getBackupsDir(), config.keep);
    const status: AutoBackupStatus = {
      at,
      ok: true,
      reason,
      file: made.file,
      ...(copied ? { copied } : {}),
      lastOkAt: at,
    };
    await writeStatus(status);
    return status;
  })().finally(() => {
    running = null;
  });
  return running;
}

let timer: NodeJS.Timeout | null = null;
const CHECK_EVERY_MS = 10 * 60_000;

/** Check every 10 minutes whether a scheduled backup is due. */
export function startAutoBackupSchedule(): void {
  if (timer) return;
  const tick = () =>
    void (async () => {
      const settings: any = await coreServices.readSettings();
      const config = autoBackupConfig(settings);
      if (!config.enabled) return;
      const status = await readAutoBackupStatus();
      if (
        scheduledBackupDue({
          config,
          lastOkAt: status?.lastOkAt,
          lastAttemptAt: status?.at,
          now: Date.now(),
        })
      ) {
        await runAutoBackup('schedule');
      }
    })().catch(logIgnored('autoBackup:tick', undefined));
  setTimeout(tick, 2 * 60_000).unref?.();
  timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref?.();
}

export function stopAutoBackupSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
