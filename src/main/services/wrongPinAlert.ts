import { prisma } from '@db/client';
import { KeyedAsyncMutex } from '@shared/asyncMutex';

export const WRONG_PIN_MESSAGE = 'Wrong PIN attempt on your account';
export const WRONG_PIN_WINDOW_MINUTES = 15;
/** Prefix of the admins' copy: "Wrong PIN attempts on Ana's account (3)". */
export const STAFF_WRONG_PIN_PREFIX = 'Wrong PIN attempts on ';

/** "Wrong PIN attempt on your account (3 in the last 15 minutes)". */
export function wrongPinMessage(recentCount: number): string {
  const n = Math.max(1, Math.floor(Number(recentCount) || 1));
  return n > 1
    ? `${WRONG_PIN_MESSAGE} (${n} in the last ${WRONG_PIN_WINDOW_MINUTES} minutes)`
    : WRONG_PIN_MESSAGE;
}

/** "Wrong PIN attempts on Ana's account (3 in the last 15 minutes)". */
export function staffWrongPinMessage(
  name: string,
  recentCount: number,
): string {
  const n = Math.max(1, Math.floor(Number(recentCount) || 1));
  return `${STAFF_WRONG_PIN_PREFIX}${name}'s account (${n} in the last ${WRONG_PIN_WINDOW_MINUTES} minutes)`;
}

/** The count a collapsed alert already carries (1 for the plain text). */
export function countInWrongPinMessage(message: unknown): number {
  const m = /\((\d+) in the last/.exec(String(message || ''));
  return m ? Math.max(1, Number(m[1])) : 1;
}

// One writer per account: 20 parallel misses used to each count the rows
// before any was written, and all 20 said "first attempt".
const perUser = new KeyedAsyncMutex();

/**
 * Bump the alert `userId` already has whose message starts with `prefix`
 * (seen within the window), or write the first one. The row is marked
 * unread and moved to now, so a run of attempts is one alert that keeps
 * counting instead of a screen of copies.
 */
async function bumpAlert(input: {
  userId: number;
  prefix: string;
  message: (n: number) => string;
  now: number;
}): Promise<void> {
  const since = new Date(input.now - WRONG_PIN_WINDOW_MINUTES * 60_000);
  const existing = (await prisma.notification
    .findFirst({
      where: {
        userId: input.userId,
        type: 'SECURITY' as any,
        createdAt: { gte: since } as any,
        message: { startsWith: input.prefix } as any,
      } as any,
      orderBy: { createdAt: 'desc' },
    } as any)
    .catch(() => null)) as { id: number; message: string } | null;
  if (existing) {
    const updated = await prisma.notification
      .update({
        where: { id: existing.id },
        data: {
          message: input.message(countInWrongPinMessage(existing.message) + 1),
          readAt: null,
          createdAt: new Date(input.now),
        } as any,
      })
      .then(() => true)
      .catch(() => false);
    if (updated) return;
  }
  await prisma.notification
    .create({
      data: {
        userId: input.userId,
        type: 'SECURITY' as any,
        message: input.message(1),
      },
    })
    .catch(() => {});
}

/**
 * Record a wrong PIN on a known account: one SECURITY alert for the account
 * owner that counts up, and, for a staff (non-admin) account, one for every
 * admin naming whose account it was. Till and phone logins share it;
 * malformed PINs count too, they are still a guess.
 */
export async function recordWrongPinAttempt(
  userId: number,
  now = Date.now(),
): Promise<void> {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return;
  await perUser.runExclusive(String(id), async () => {
    await bumpAlert({
      userId: id,
      prefix: WRONG_PIN_MESSAGE,
      message: wrongPinMessage,
      now,
    });
    const target = (await prisma.user
      .findUnique({ where: { id } })
      .catch(() => null)) as { displayName?: string; role?: string } | null;
    if (!target || String(target.role || '').toUpperCase() === 'ADMIN') return;
    const name = String(target.displayName || `#${id}`);
    const admins = (await prisma.user
      .findMany({ where: { role: 'ADMIN', active: true } as any, take: 50 })
      .catch(() => [])) as Array<{ id: number }>;
    for (const a of admins) {
      await bumpAlert({
        userId: a.id,
        prefix: `${STAFF_WRONG_PIN_PREFIX}${name}'s account`,
        message: (n) => staffWrongPinMessage(name, n),
        now,
      });
    }
  });
}
