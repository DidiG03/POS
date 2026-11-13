/**
 * Lock a screen after it has not been touched for a while.
 *
 * Nothing locked the till, a waiter's phone or the Admin app: a session
 * lasted 12 hours, so whoever picked up a shared device next acted as the
 * last person signed in, and their sales and voids were booked to them.
 * After `security.idleLockMinutes` without a touch, key or click, the
 * screen now goes back to the PIN pad. Nothing is lost: an order still
 * being typed and orders waiting to reach the till stay on the device for
 * that person's next sign-in.
 */

/** Minutes a venue can choose; 0 is off. */
export const IDLE_LOCK_CHOICES = [0, 2, 5, 10, 15, 30] as const;
export type IdleLockMinutes = (typeof IDLE_LOCK_CHOICES)[number];
export const IDLE_LOCK_DEFAULT_MINUTES: IdleLockMinutes = 10;

export function idleLockMinutes(settings: unknown): IdleLockMinutes {
  const raw = (settings as any)?.security?.idleLockMinutes;
  if (raw === undefined || raw === null || raw === '') {
    return IDLE_LOCK_DEFAULT_MINUTES;
  }
  const n = Number(raw);
  return (IDLE_LOCK_CHOICES as readonly number[]).includes(n)
    ? (n as IdleLockMinutes)
    : IDLE_LOCK_DEFAULT_MINUTES;
}

/** Why a saved `security.idleLockMinutes` cannot be used, or null. */
export function idleLockProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  return (IDLE_LOCK_CHOICES as readonly number[]).includes(Number(raw))
    ? null
    : `Screen lock: choose one of ${IDLE_LOCK_CHOICES.filter((m) => m > 0).join(', ')} minutes, or off.`;
}

export function shouldIdleLock(input: {
  minutes: number;
  lastActivityMs: number;
  nowMs: number;
  signedIn: boolean;
}): boolean {
  if (!input.signedIn || !(input.minutes > 0)) return false;
  return input.nowMs - input.lastActivityMs >= input.minutes * 60_000;
}
