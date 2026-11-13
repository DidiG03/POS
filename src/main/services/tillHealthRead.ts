/** The facts behind `tillHealth.ts`, read on the till. */
import { app } from 'electron';
import { prisma } from '@db/client';
import {
  freeBytesAt,
  HEALTH_NOTIFIED_KEY,
  healthWarningsToNotify,
  tillHealthWarnings,
  type TillHealthWarning,
} from './tillHealth';
import { readBackupSavedElsewhere } from './dbBackups';
import { clockOffsetMs } from './fiscal/clock';
import { notifyAdminsAndActor } from './adminAlerts';
import { logIgnored } from './logIgnored';

export async function readTillHealth(nowMs = Date.now()): Promise<{
  warnings: TillHealthWarning[];
  savedElsewhereAt: string | null;
  freeBytes: number | null;
}> {
  const saved = await readBackupSavedElsewhere();
  const firstUser = await prisma.user
    .findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    .catch(logIgnored('tillHealth:firstUser', null));
  const freeBytes = freeBytesAt(app.getPath('userData'));
  const warnings = tillHealthWarnings({
    nowMs,
    freeBytes,
    savedElsewhereAt: saved?.at ?? null,
    installedAt: firstUser?.createdAt
      ? new Date(firstUser.createdAt).toISOString()
      : null,
    clockOffsetMs: clockOffsetMs(nowMs),
  });
  return { warnings, savedElsewhereAt: saved?.at ?? null, freeBytes };
}

/** Tell the admins about each warning at most once a day. */
export async function notifyTillHealth(nowMs = Date.now()): Promise<void> {
  const { warnings } = await readTillHealth(nowMs);
  if (!warnings.length) return;
  const row = await prisma.syncState
    .findUnique({ where: { key: HEALTH_NOTIFIED_KEY } })
    .catch(logIgnored('tillHealth:readNotified', null));
  const last = ((row as any)?.valueJson || {}) as Record<string, string>;
  const due = healthWarningsToNotify(warnings, last, nowMs);
  if (!due.length) return;
  for (const w of due) {
    await notifyAdminsAndActor({ message: w.message, type: 'SECURITY' });
    last[w.kind] = new Date(nowMs).toISOString();
  }
  await prisma.syncState
    .upsert({
      where: { key: HEALTH_NOTIFIED_KEY },
      create: { key: HEALTH_NOTIFIED_KEY, valueJson: last as any },
      update: { valueJson: last as any },
    })
    .catch(logIgnored('tillHealth:writeNotified', null));
}

let timer: NodeJS.Timeout | null = null;
export function startTillHealthChecks(): void {
  if (timer) return;
  const run = () =>
    void notifyTillHealth().catch(logIgnored('tillHealth', null));
  setTimeout(run, 60_000).unref?.();
  timer = setInterval(run, 6 * 60 * 60_000);
  timer.unref?.();
}
export function stopTillHealthChecks(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
