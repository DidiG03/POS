/**
 * Warnings about the till itself: a disk running out of space, no backup
 * saved off this computer for a while, a clock that is wrong.
 *
 * Nothing checked these. A full disk showed up as failed sales; a till
 * whose only backups sat on its own disk lost everything with that disk;
 * a wrong clock printed wrong times on receipts. They are shown on the
 * Admin overview and sent to admins at most once a day each.
 */
import fs from 'node:fs';

export type TillHealthKind = 'disk' | 'backup' | 'clock';
export interface TillHealthWarning {
  kind: TillHealthKind;
  level: 'warn' | 'danger';
  message: string;
}

export const DISK_WARN_BYTES = 2 * 1024 ** 3;
export const DISK_DANGER_BYTES = 500 * 1024 ** 2;
export const BACKUP_WARN_DAYS = 7;
export const CLOCK_WARN_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Pure: the warnings for these facts. */
export function tillHealthWarnings(input: {
  nowMs: number;
  /** Free space where the ledger is; null when it could not be read. */
  freeBytes: number | null;
  /** When a backup was last saved off this computer, or null. */
  savedElsewhereAt: string | null;
  /** When the till was first started with this ledger (for "never"). */
  installedAt?: string | null;
  /** This till's clock minus the tax service's; null when not known. */
  clockOffsetMs: number | null;
}): TillHealthWarning[] {
  const out: TillHealthWarning[] = [];
  if (input.freeBytes != null && input.freeBytes < DISK_WARN_BYTES) {
    const danger = input.freeBytes < DISK_DANGER_BYTES;
    out.push({
      kind: 'disk',
      level: danger ? 'danger' : 'warn',
      message: `The till's disk has ${gb(input.freeBytes)} free.${
        danger ? ' Sales may soon fail to save.' : ''
      } Free up space on that computer.`,
    });
  }
  const saved = input.savedElsewhereAt
    ? Date.parse(input.savedElsewhereAt)
    : NaN;
  if (Number.isFinite(saved)) {
    const days = Math.floor((input.nowMs - saved) / DAY_MS);
    if (days >= BACKUP_WARN_DAYS) {
      out.push({
        kind: 'backup',
        level: 'warn',
        message: `No backup has been saved off the till for ${days} days. On the till, use File → Save Backup To… with a USB stick or a synced folder.`,
      });
    }
  } else {
    const installed = input.installedAt ? Date.parse(input.installedAt) : NaN;
    const age = Number.isFinite(installed) ? input.nowMs - installed : Infinity;
    if (age >= BACKUP_WARN_DAYS * DAY_MS) {
      out.push({
        kind: 'backup',
        level: 'warn',
        message:
          'No backup has ever been saved off the till. If its disk fails, every sale is lost. On the till, use File → Save Backup To… with a USB stick or a synced folder.',
      });
    }
  }
  if (
    input.clockOffsetMs != null &&
    Math.abs(input.clockOffsetMs) >= CLOCK_WARN_MS
  ) {
    const minutes = Math.round(Math.abs(input.clockOffsetMs) / 60_000);
    out.push({
      kind: 'clock',
      level: 'warn',
      message: `The till's clock is ${minutes} minutes ${
        input.clockOffsetMs > 0 ? 'fast' : 'slow'
      }. Receipts and reports use it: set the time on that computer.`,
    });
  }
  return out;
}

export function freeBytesAt(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export const HEALTH_NOTIFIED_KEY = 'health:lastNotified';

/** Which warnings are due a notice: each kind at most once a day. */
export function healthWarningsToNotify(
  warnings: TillHealthWarning[],
  lastNotified: Record<string, string>,
  nowMs: number,
): TillHealthWarning[] {
  return warnings.filter((w) => {
    const last = Date.parse(lastNotified[w.kind] || '');
    return !Number.isFinite(last) || nowMs - last >= DAY_MS;
  });
}
