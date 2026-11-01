/**
 * Per-waiter fiskalizimi switch.
 *
 * Fiskalizimi is a venue-wide setting (`settings.fiscal.enabled`). On top of
 * it, each staff member can have it switched off for the payments they take:
 * on the waiter POS, holding your own name in the top-left corner of the
 * header for five seconds opens a dialog where, after your PIN, fiskalizimi
 * can be turned off or back on for you alone.
 *
 * Only exceptions are stored (the ids of staff with it switched OFF), so a
 * new waiter always starts with fiskalizimi on, and the venue-wide switch
 * still wins: with it off, nobody's payments are fiscalized.
 *
 * Every change is logged and reported to the admins, the same as the
 * venue-wide toggle (`fiscalToggleAudit.ts`).
 */

import bcrypt from 'bcryptjs';
import { prisma } from '@db/client';
import { normalizePin } from '@shared/staffPin';
import { notifyAdminsAndActor } from './adminAlerts';
import { logSecurityEvent } from './security';

export const WAITER_FISCAL_KEY = 'fiscal:waiterOff';

/** Ids of staff whose payments are not fiscalized. */
export async function readWaiterFiscalOff(): Promise<number[]> {
  const row = await prisma.syncState
    .findUnique({ where: { key: WAITER_FISCAL_KEY } })
    .catch(() => null);
  const ids = (row?.valueJson as any)?.userIds;
  if (!Array.isArray(ids)) return [];
  return ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
}

async function writeWaiterFiscalOff(ids: number[]): Promise<void> {
  const valueJson = { userIds: [...new Set(ids)].sort((a, b) => a - b) } as any;
  await prisma.syncState.upsert({
    where: { key: WAITER_FISCAL_KEY },
    create: { key: WAITER_FISCAL_KEY, valueJson },
    update: { valueJson },
  });
}

export async function isFiscalEnabledForUser(
  userId: number | null | undefined,
): Promise<boolean> {
  const id = Number(userId || 0);
  if (!Number.isInteger(id) || id <= 0) return true;
  return !(await readWaiterFiscalOff()).includes(id);
}

/**
 * The settings to fiscalize a payment with: unchanged, unless the person
 * taking the payment has fiskalizimi switched off, in which case the copy
 * reads as fiskalizimi disabled. If the lookup fails the payment is
 * fiscalized as usual — failing towards reporting, never away from it.
 */
export async function fiscalSettingsForActor<T>(
  settings: T,
  userId: number | null | undefined,
): Promise<T> {
  const fiscal = (settings as any)?.fiscal;
  if (fiscal?.enabled !== true) return settings;
  let enabled = true;
  try {
    enabled = await isFiscalEnabledForUser(userId);
  } catch {
    enabled = true;
  }
  if (enabled) return settings;
  return { ...(settings as any), fiscal: { ...fiscal, enabled: false } };
}

export type WaiterFiscalResult =
  | { ok: true; enabled: boolean; changed: boolean }
  | { ok: false; code: 'WRONG_PIN' | 'NOT_FOUND' | 'INVALID' };

/**
 * Read (when `enabled` is omitted) or set fiskalizimi for one staff member.
 * Needs that staff member's own PIN either way.
 */
export async function manageWaiterFiscal(input: {
  userId: unknown;
  pin: unknown;
  enabled?: unknown;
  source: 'till' | 'lan';
  now?: Date;
}): Promise<WaiterFiscalResult> {
  const userId = Number(input.userId);
  const pin = typeof input.pin === 'string' ? input.pin : '';
  if (!Number.isInteger(userId) || userId <= 0 || !pin) {
    return { ok: false, code: 'INVALID' };
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return { ok: false, code: 'INVALID' };
  }
  const user = await prisma.user
    .findFirst({ where: { id: userId, active: true } })
    .catch(() => null);
  if (!user) return { ok: false, code: 'NOT_FOUND' };
  const pinOk = await bcrypt
    .compare(normalizePin(pin), user.pinHash)
    .catch(() => false);
  if (!pinOk) return { ok: false, code: 'WRONG_PIN' };

  const off = await readWaiterFiscalOff();
  const current = !off.includes(userId);
  if (input.enabled === undefined || input.enabled === current) {
    return { ok: true, enabled: current, changed: false };
  }
  const enabled = input.enabled as boolean;
  await writeWaiterFiscalOff(
    enabled ? off.filter((id) => id !== userId) : [...off, userId],
  );

  try {
    const now = input.now ?? new Date();
    const who = String(user.displayName || '').trim() || `User #${userId}`;
    const via = input.source === 'lan' ? 'a phone/tablet' : 'the till';
    logSecurityEvent('waiter_fiscal_toggled', {
      userId,
      enabled,
      source: input.source,
    });
    await notifyAdminsAndActor({
      message: enabled
        ? `Fiskalizimi was switched back ON for ${who} from ${via} at ${now.toLocaleString()}.`
        : `Fiskalizimi was switched OFF for ${who} from ${via} at ${now.toLocaleString()}. Payments taken by ${who} are NOT reported to the tax office until it is switched back on.`,
      actorUserId: userId,
      type: 'SECURITY',
    }).catch(() => undefined);
  } catch (e) {
    console.warn('[fiscal] waiter toggle audit failed:', e);
  }
  return { ok: true, enabled, changed: true };
}
