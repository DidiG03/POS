/**
 * Per-waiter fiskalizimi switch.
 *
 * Fiskalizimi is a venue-wide setting (`settings.fiscal.enabled`). On top of
 * it, each staff member can have it switched off for the payments they take:
 * on the till, holding a name in the header for five seconds opens a
 * dialog where, with an admin's PIN, fiskalizimi can be turned off or back
 * on for that person. The phone app no longer offers it (QA v0.2.104, #4).
 * Their sales are then not filed at once but kept as not yet fiscalised,
 * for review and filing (`waiterFiscalHold`).
 *
 * Only exceptions are stored (the ids of staff with it switched OFF), so a
 * new waiter always starts with fiskalizimi on, and the venue-wide switch
 * still wins: with it off, nobody's payments are fiscalized.
 *
 * Every change is logged and reported to the admins, the same as the
 * venue-wide toggle (`fiscalToggleAudit.ts`).
 */

import { prisma } from '@db/client';
import { notifyAdminsAndActor } from './adminAlerts';
import { verifyManagerPin } from './managerPin';
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
 * Why this person's payment is not sent to the tax office now, or
 * undefined. Fiskalizimi switched off for one waiter used to hand the
 * payment settings with fiskalizimi disabled: the sale was recorded as if
 * the venue did not fiscalise at all, with no "not yet fiscalised" mark and
 * nothing to file later (QA v0.2.104, #4). The payment now goes through
 * the same held path as an invoice waiting for a person (`fiscal/index.ts`
 * `holdReason`): recorded, its invoice queued for review, the receipt
 * marked not yet fiscalised, the admins told. A failed lookup holds
 * nothing: the sale is fiscalised as usual.
 */
export async function waiterFiscalHold(
  settings: unknown,
  userId: number | null | undefined,
): Promise<string | undefined> {
  if ((settings as any)?.fiscal?.enabled !== true) return undefined;
  let enabled = true;
  try {
    enabled = await isFiscalEnabledForUser(userId);
  } catch {
    enabled = true;
  }
  if (enabled) return undefined;
  return `Fiskalizimi is switched off for this staff member (#${Number(userId)}), so this sale was not sent to the tax office. Check it, then choose "Send again" here to file it, or switch fiskalizimi back on for them.`;
}

/** Every change, kept on the till (who, for whom, approved by which admin). */
export const WAITER_FISCAL_LOG_KEY = 'fiscal:waiterToggleLog';
const LOG_LIMIT = 500;

export type WaiterFiscalLogEntry = {
  at: string;
  userId: number;
  userName: string | null;
  enabled: boolean;
  approvedByAdminId: number;
  approvedByName: string | null;
  source: 'till' | 'lan';
};

export async function listWaiterFiscalLog(): Promise<WaiterFiscalLogEntry[]> {
  const row = await prisma.syncState
    .findUnique({ where: { key: WAITER_FISCAL_LOG_KEY } })
    .catch(() => null);
  const entries = (row?.valueJson as any)?.entries;
  return Array.isArray(entries) ? entries : [];
}

async function appendWaiterFiscalLog(
  entry: WaiterFiscalLogEntry,
): Promise<void> {
  const entries = [...(await listWaiterFiscalLog()), entry].slice(-LOG_LIMIT);
  const valueJson = { entries } as any;
  await prisma.syncState.upsert({
    where: { key: WAITER_FISCAL_LOG_KEY },
    create: { key: WAITER_FISCAL_LOG_KEY, valueJson },
    update: { valueJson },
  });
}

export type WaiterFiscalResult =
  | { ok: true; enabled: boolean; changed: boolean }
  | {
      ok: false;
      code: 'WRONG_PIN' | 'NOT_FOUND' | 'INVALID' | 'LOCKED';
      lockedForMs?: number;
      attemptsLeft?: number;
    };

/**
 * Read (when `enabled` is omitted) or set fiskalizimi for one staff member.
 *
 * Needs an admin's PIN, checked here (QA v0.2.104, #4). The waiter's own
 * PIN used to be enough, so anyone signed in on any device could switch
 * fiskalizimi off for themselves. The admin PIN goes through the
 * manager-PIN check (`managerPin.ts`), with its delays and lockouts.
 */
export async function manageWaiterFiscal(input: {
  userId: unknown;
  /** An admin's PIN. */
  managerPin: unknown;
  enabled?: unknown;
  source: 'till' | 'lan';
  /** Who is asking: the phone's IP or the till window (lockouts). */
  requester?: string;
  now?: Date;
}): Promise<WaiterFiscalResult> {
  const userId = Number(input.userId);
  const pin = typeof input.managerPin === 'string' ? input.managerPin : '';
  if (!Number.isInteger(userId) || userId <= 0 || !pin) {
    return { ok: false, code: 'INVALID' };
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return { ok: false, code: 'INVALID' };
  }
  const approval = await verifyManagerPin({
    pin,
    source: `waiter-fiscal:${input.requester || input.source}`,
    lan: input.source === 'lan',
  });
  if (!approval.ok) {
    return approval.lockedForMs
      ? {
          ok: false,
          code: 'LOCKED',
          lockedForMs: approval.lockedForMs,
          ...(approval.attemptsLeft != null
            ? { attemptsLeft: approval.attemptsLeft }
            : {}),
        }
      : {
          ok: false,
          code: 'WRONG_PIN',
          ...(approval.attemptsLeft != null
            ? { attemptsLeft: approval.attemptsLeft }
            : {}),
        };
  }
  const user = await prisma.user
    .findFirst({ where: { id: userId, active: true } })
    .catch(() => null);
  if (!user) return { ok: false, code: 'NOT_FOUND' };

  const off = await readWaiterFiscalOff();
  const current = !off.includes(userId);
  if (input.enabled === undefined || input.enabled === current) {
    return { ok: true, enabled: current, changed: false };
  }
  const enabled = input.enabled as boolean;
  await writeWaiterFiscalOff(
    enabled ? off.filter((id) => id !== userId) : [...off, userId],
  );

  const now = input.now ?? new Date();
  const who = String(user.displayName || '').trim() || `User #${userId}`;
  const admin = approval.admin;
  try {
    await appendWaiterFiscalLog({
      at: now.toISOString(),
      userId,
      userName: String(user.displayName || '').trim() || null,
      enabled,
      approvedByAdminId: admin.id,
      approvedByName: String(admin.displayName || '').trim() || null,
      source: input.source,
    });
  } catch (e) {
    console.warn('[fiscal] waiter toggle log failed:', e);
  }
  try {
    const via = input.source === 'lan' ? 'a phone/tablet' : 'the till';
    const by = String(admin.displayName || '').trim() || `admin #${admin.id}`;
    logSecurityEvent('waiter_fiscal_toggled', {
      userId,
      enabled,
      approvedByAdminId: admin.id,
      source: input.source,
    });
    await notifyAdminsAndActor({
      message: enabled
        ? `Fiskalizimi was switched back ON for ${who} from ${via} at ${now.toLocaleString()}, approved by ${by}.`
        : `Fiskalizimi was switched OFF for ${who} from ${via} at ${now.toLocaleString()}, approved by ${by}. ${who}'s payments are recorded as not yet fiscalised and wait in Fiskalizimi › review until they are filed.`,
      actorUserId: userId,
      type: 'SECURITY',
    }).catch(() => undefined);
  } catch (e) {
    console.warn('[fiscal] waiter toggle audit failed:', e);
  }
  return { ok: true, enabled, changed: true };
}
