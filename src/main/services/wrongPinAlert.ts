import { prisma } from '@db/client';

export const WRONG_PIN_MESSAGE = 'Wrong PIN attempt on your account';
export const WRONG_PIN_WINDOW_MINUTES = 15;

/** "Wrong PIN attempt on your account (3 in the last 15 minutes)". */
export function wrongPinMessage(recentCount: number): string {
  const n = Math.max(1, Math.floor(Number(recentCount) || 1));
  return n > 1
    ? `${WRONG_PIN_MESSAGE} (${n} in the last ${WRONG_PIN_WINDOW_MINUTES} minutes)`
    : WRONG_PIN_MESSAGE;
}

/**
 * One SECURITY notification per wrong PIN on a known account, numbered so
 * a run of attempts reads as a run instead of identical rows. Till and phone
 * logins share it; malformed PINs count too, they are still a guess.
 */
export async function recordWrongPinAttempt(
  userId: number,
  now = Date.now(),
): Promise<void> {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return;
  const since = new Date(now - WRONG_PIN_WINDOW_MINUTES * 60_000);
  const earlier = await prisma.notification
    .count({
      where: {
        userId: id,
        type: 'SECURITY' as any,
        createdAt: { gte: since } as any,
        message: { startsWith: WRONG_PIN_MESSAGE } as any,
      } as any,
    })
    .catch(() => 0);
  await prisma.notification
    .create({
      data: {
        userId: id,
        type: 'SECURITY' as any,
        message: wrongPinMessage(earlier + 1),
      },
    })
    .catch(() => {});
}
