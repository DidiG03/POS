/**
 * Failed-login throttle for the LAN HTTP API.
 *
 * `/auth/login` used to have no limit at all, and an ADMIN login does not need
 * the pairing code (Admin is the one that issues it). Anyone on the venue
 * Wi-Fi could therefore walk the 10,000 four-digit admin PINs in minutes and
 * come away with a token that can restore backups and rewrite settings.
 *
 * A waiter locked out mid-service is still the worse outcome for a single
 * mistyped PIN, so this is graded rather than a flat cap:
 *
 *   - every failure from an IP adds a short delay (the same shape as the IPC
 *     throttle on the till), which costs a person nothing;
 *   - `LOCK_AFTER_FAILURES` failures from one IP inside the window lock that
 *     IP out of LAN login for `IP_LOCK_MS`;
 *   - an ADMIN account additionally locks for LAN login after
 *     `ADMIN_LOCK_AFTER_FAILURES` failures from any mix of IPs, so rotating
 *     addresses does not reset the budget. The till itself (loopback) is never
 *     throttled, so an owner can always sign in at the counter.
 *
 * Pairing-code misses count as failures too: `/pairing/verify` is otherwise a
 * free oracle for the 6-digit code.
 */

export const FAIL_WINDOW_MS = 10 * 60_000;
export const LOCK_AFTER_FAILURES = 10;
export const IP_LOCK_MS = 5 * 60_000;
export const ADMIN_LOCK_AFTER_FAILURES = 20;
export const ADMIN_LOCK_MS = 15 * 60_000;
export const DELAY_STEP_MS = 250;
export const DELAY_MAX_MS = 2_000;

type Counter = { failures: number; windowStart: number; lockedUntil: number };

const byIp = new Map<string, Counter>();
const byAdmin = new Map<number, Counter>();

function current<K>(map: Map<K, Counter>, key: K, now: number): Counter {
  const cur = map.get(key);
  if (
    !cur ||
    (cur.lockedUntil <= now && now - cur.windowStart > FAIL_WINDOW_MS)
  ) {
    const fresh = { failures: 0, windowStart: now, lockedUntil: 0 };
    map.set(key, fresh);
    return fresh;
  }
  return cur;
}

function remaining(c: Counter | undefined, now: number): number {
  if (!c || c.lockedUntil <= now) return 0;
  return c.lockedUntil - now;
}

/** Milliseconds this IP must wait before trying again, or 0. */
export function lanLoginIpLockedFor(ip: string, now = Date.now()): number {
  return remaining(byIp.get(String(ip || '')), now);
}

/** Milliseconds this admin account is locked for LAN login, or 0. */
export function lanLoginAdminLockedFor(
  userId: number,
  now = Date.now(),
): number {
  return remaining(byAdmin.get(Number(userId)), now);
}

export interface LanLoginFailure {
  /** Pause to apply before answering, so guessing stays slow. */
  delayMs: number;
  /** True when this failure just locked the IP. */
  ipLocked: boolean;
  /** True when this failure just locked the admin account. */
  adminLocked: boolean;
}

/**
 * Record one failed attempt. Pass `adminUserId` when the targeted account is
 * an ADMIN so the account budget applies across IPs.
 */
export function recordLanLoginFailure(
  ip: string,
  opts: { adminUserId?: number | null } = {},
  now = Date.now(),
): LanLoginFailure {
  const ipCounter = current(byIp, String(ip || ''), now);
  ipCounter.failures += 1;
  let ipLocked = false;
  if (
    ipCounter.failures >= LOCK_AFTER_FAILURES &&
    ipCounter.lockedUntil <= now
  ) {
    ipCounter.lockedUntil = now + IP_LOCK_MS;
    ipLocked = true;
  }

  let adminLocked = false;
  const adminId = Number(opts.adminUserId || 0);
  if (adminId > 0) {
    const adminCounter = current(byAdmin, adminId, now);
    adminCounter.failures += 1;
    if (
      adminCounter.failures >= ADMIN_LOCK_AFTER_FAILURES &&
      adminCounter.lockedUntil <= now
    ) {
      adminCounter.lockedUntil = now + ADMIN_LOCK_MS;
      adminLocked = true;
    }
  }

  return {
    delayMs: Math.min(DELAY_MAX_MS, ipCounter.failures * DELAY_STEP_MS),
    ipLocked,
    adminLocked,
  };
}

/**
 * A successful login from this IP clears that IP's failures. The admin
 * account budget is left to expire on its own: otherwise the real admin
 * signing in from one device would reset a guesser's budget on another.
 */
export function clearLanLoginFailures(ip: string): void {
  byIp.delete(String(ip || ''));
}

/** Test seam. */
export function __resetLanLoginThrottleForTests(): void {
  byIp.clear();
  byAdmin.clear();
}
