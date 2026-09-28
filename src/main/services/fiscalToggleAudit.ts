/**
 * Audit trail for switching fiskalizimi on and off.
 *
 * While fiscalization is off every payment is recorded locally and never
 * reported to the tax service. Switching it off used to leave no trace at
 * all: no log line, no alert, nothing that later showed which sales were
 * taken in that window. Now each switch is logged (security log and a
 * persistent history), every admin is told who did it, and switching back
 * on reports how many sales, and for how much, were taken while it was off.
 */

import { prisma } from '@db/client';
import { notifyAdminsAndActor } from './adminAlerts';
import { logSecurityEvent } from './security';

export const FISCAL_TOGGLE_LOG_KEY = 'fiscal:toggleLog';
const LOG_LIMIT = 500;

export type FiscalToggleEntry = {
  at: string;
  enabled: boolean;
  actorUserId: number | null;
  actorName: string | null;
  source: 'till' | 'lan';
};

export function fiscalEnabledOf(settings: unknown): boolean {
  return (settings as any)?.fiscal?.enabled === true;
}

async function readLog(): Promise<FiscalToggleEntry[]> {
  const row = await prisma.syncState
    .findUnique({ where: { key: FISCAL_TOGGLE_LOG_KEY } })
    .catch(() => null);
  const entries = (row?.valueJson as any)?.entries;
  return Array.isArray(entries) ? (entries as FiscalToggleEntry[]) : [];
}

async function writeLog(entries: FiscalToggleEntry[]): Promise<void> {
  const valueJson = { entries: entries.slice(-LOG_LIMIT) } as any;
  await prisma.syncState.upsert({
    where: { key: FISCAL_TOGGLE_LOG_KEY },
    create: { key: FISCAL_TOGGLE_LOG_KEY, valueJson },
    update: { valueJson },
  });
}

/** Sales recorded since `since`: how many, and their total. */
async function salesSince(
  since: Date,
): Promise<{ count: number; total: number }> {
  const agg = await (prisma as any).payment
    .aggregate({
      where: { paidAt: { gte: since } },
      _count: { _all: true },
      _sum: { amount: true },
    })
    .catch(() => null);
  const count = Number(agg?._count?._all ?? agg?._count ?? 0) || 0;
  const total = Number(agg?._sum?.amount ?? 0) || 0;
  return { count, total };
}

/**
 * Call after a settings save with the fiscal flag from before the save.
 * Never throws: an audit problem must not undo or fail the save itself.
 */
export async function auditFiscalToggle(input: {
  wasEnabled: boolean;
  settings: unknown;
  actorUserId?: number | null;
  source: 'till' | 'lan';
  now?: Date;
}): Promise<'none' | 'off' | 'on'> {
  const isEnabled = fiscalEnabledOf(input.settings);
  if (isEnabled === input.wasEnabled) return 'none';
  const now = input.now ?? new Date();
  try {
    const actorUserId = Number(input.actorUserId || 0) || null;
    const actor = actorUserId
      ? await prisma.user
          .findUnique({
            where: { id: actorUserId },
            select: { displayName: true },
          })
          .catch(() => null)
      : null;
    const actorName = String(actor?.displayName || '').trim() || null;
    const who = actorName || (actorUserId ? `User #${actorUserId}` : 'unknown');
    const via = input.source === 'lan' ? 'a phone/tablet' : 'the till';

    const log = await readLog();
    const entry: FiscalToggleEntry = {
      at: now.toISOString(),
      enabled: isEnabled,
      actorUserId,
      actorName,
      source: input.source,
    };
    await writeLog([...log, entry]).catch(() => undefined);
    logSecurityEvent('fiscal_toggled', {
      enabled: isEnabled,
      actorUserId,
      source: input.source,
    });

    let message: string;
    if (!isEnabled) {
      message =
        `Fiskalizimi was switched OFF by ${who} from ${via} at ${now.toLocaleString()}.` +
        ' From now on sales are NOT reported to the tax office.';
    } else {
      const lastOff = [...log].reverse().find((e) => e.enabled === false);
      const offAt = lastOff ? new Date(lastOff.at) : null;
      const offSales =
        offAt && Number.isFinite(offAt.getTime())
          ? await salesSince(offAt)
          : null;
      message =
        `Fiskalizimi was switched back ON by ${who} from ${via} at ${now.toLocaleString()}.` +
        (offSales && offAt
          ? ` While it was off (since ${offAt.toLocaleString()}), ${offSales.count} sale(s) worth ${offSales.total.toFixed(2)} were taken and not reported to the tax office.`
          : '');
    }
    await notifyAdminsAndActor({
      message,
      actorUserId: actorUserId || undefined,
      type: 'SECURITY',
    }).catch(() => undefined);
    return isEnabled ? 'on' : 'off';
  } catch (e) {
    console.warn('[fiscal] toggle audit failed:', e);
    return isEnabled ? 'on' : 'off';
  }
}
