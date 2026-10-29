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
 *   - every failure adds a short delay (the same shape as the IPC throttle
 *     on the till), which costs a person nothing;
 *   - `LOCK_AFTER_FAILURES` failures for one account from one device inside
 *     the window lock that account on that device for `IP_LOCK_MS`. Other
 *     staff sharing the tablet keep signing in;
 *   - every account (waiters too: their PINs can be one character) locks for
 *     LAN login after `ACCOUNT_LOCK_AFTER_FAILURES` failures from any mix of
 *     devices, so rotating addresses does not reset the budget;
 *   - `IP_SPRAY_LOCK_AFTER_FAILURES` failures from one device across all
 *     accounts lock the device, so it cannot walk every name in turn.
 *
 * The till itself (loopback) is never throttled, so an owner can always sign
 * in at the counter.
 *
 * An attempt is reserved with `beginLanLoginAttempt` before the PIN is
 * checked. The check is async (bcrypt), and counting only after it let 30
 * parallel guesses all pass the lock check before the first miss was
 * counted. Reserved attempts count against every budget, so exactly
 * `LOCK_AFTER_FAILURES` guesses are ever checked.
 *
 * Pairing-code misses count as failures too: `/pairing/verify` is otherwise a
 * free oracle for the 6-digit code.
 */

export const FAIL_WINDOW_MS = 10 * 60_000;
export const LOCK_AFTER_FAILURES = 10;
export const IP_LOCK_MS = 5 * 60_000;
export const ACCOUNT_LOCK_AFTER_FAILURES = 20;
export const ACCOUNT_LOCK_MS = 15 * 60_000;
export const IP_SPRAY_LOCK_AFTER_FAILURES = 30;
export const DELAY_STEP_MS = 250;
export const DELAY_MAX_MS = 2_000;
/** Answer for a guess refused only because others are still being checked. */
export const BUSY_RETRY_MS = 2_000;

type Counter = {
  failures: number;
  /** Attempts reserved and not yet answered. */
  pending: number;
  windowStart: number;
  lockedUntil: number;
};

const byDevice = new Map<string, Counter>();
const byAccount = new Map<number, Counter>();
const byIp = new Map<string, Counter>();

function deviceKey(ip: string, userId: number): string {
  return `${String(ip || '')}#${Number(userId) || 0}`;
}

function current<K>(map: Map<K, Counter>, key: K, now: number): Counter {
  const cur = map.get(key);
  if (
    !cur ||
    (cur.pending === 0 &&
      cur.lockedUntil <= now &&
      now - cur.windowStart > FAIL_WINDOW_MS)
  ) {
    const fresh = { failures: 0, pending: 0, windowStart: now, lockedUntil: 0 };
    map.set(key, fresh);
    return fresh;
  }
  return cur;
}

function remaining(c: Counter | undefined, now: number): number {
  if (!c || c.lockedUntil <= now) return 0;
  return c.lockedUntil - now;
}

/** Milliseconds this account must wait on this device, or 0. */
export function lanLoginDeviceLockedFor(
  ip: string,
  userId: number,
  now = Date.now(),
): number {
  return Math.max(
    remaining(byDevice.get(deviceKey(ip, userId)), now),
    remaining(byIp.get(String(ip || '')), now),
  );
}

/** Milliseconds this device is locked for every account, or 0. */
export function lanLoginIpLockedFor(ip: string, now = Date.now()): number {
  return Math.max(
    remaining(byIp.get(String(ip || '')), now),
    // Pairing and unknown-account misses are kept under account 0.
    remaining(byDevice.get(deviceKey(ip, 0)), now),
  );
}

/** Milliseconds this account is locked for LAN login, or 0. */
export function lanLoginAccountLockedFor(
  userId: number,
  now = Date.now(),
): number {
  return remaining(byAccount.get(Number(userId)), now);
}

export interface LanLoginFailure {
  /** Pause to apply before answering, so guessing stays slow. */
  delayMs: number;
  /** True when this failure just locked the account on this device. */
  ipLocked: boolean;
  /** True when this failure just locked the account everywhere. */
  accountLocked: boolean;
  /** True when this failure just locked the whole device. */
  deviceLocked: boolean;
  /** Failures left on this device before the account locks here. */
  attemptsLeft: number;
}

export type LanLoginAttempt =
  | {
      ok: false;
      lockedForMs: number;
      /** Refused because other guesses are still in flight, not locked. */
      busy?: boolean;
    }
  | {
      ok: true;
      fail: (now?: number) => LanLoginFailure;
      succeed: () => void;
      /** Give the reservation back without counting it (e.g. a 5xx). */
      release: () => void;
    };

/**
 * Reserve one login attempt for `userId` (0 = unknown account or pairing)
 * from `ip`. Synchronous, so parallel requests cannot all see the same
 * unlocked budget. Exactly one of `fail`, `succeed` or `release` must be
 * called afterwards.
 */
export function beginLanLoginAttempt(
  ip: string,
  userId: number,
  now = Date.now(),
): LanLoginAttempt {
  const uid = Number(userId) || 0;
  const device = current(byDevice, deviceKey(ip, uid), now);
  const spray = current(byIp, String(ip || ''), now);
  const account = uid > 0 ? current(byAccount, uid, now) : null;

  const lockedForMs = Math.max(
    remaining(device, now),
    remaining(spray, now),
    account ? remaining(account, now) : 0,
  );
  if (lockedForMs > 0) return { ok: false, lockedForMs };
  const full =
    device.failures + device.pending >= LOCK_AFTER_FAILURES ||
    spray.failures + spray.pending >= IP_SPRAY_LOCK_AFTER_FAILURES ||
    (account !== null &&
      account.failures + account.pending >= ACCOUNT_LOCK_AFTER_FAILURES);
  if (full) return { ok: false, lockedForMs: BUSY_RETRY_MS, busy: true };

  device.pending += 1;
  spray.pending += 1;
  if (account) account.pending += 1;
  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    device.pending = Math.max(0, device.pending - 1);
    spray.pending = Math.max(0, spray.pending - 1);
    if (account) account.pending = Math.max(0, account.pending - 1);
    return true;
  };

  return {
    ok: true,
    release: () => {
      settle();
    },
    succeed: () => {
      if (!settle()) return;
      // A correct PIN clears this account on this device. The account and
      // device budgets are left to expire on their own: otherwise the real
      // owner signing in on one device would reset a guesser's budget on
      // another.
      byDevice.delete(deviceKey(ip, uid));
    },
    fail: (at = now) => {
      const out: LanLoginFailure = {
        delayMs: 0,
        ipLocked: false,
        accountLocked: false,
        deviceLocked: false,
        attemptsLeft: 0,
      };
      if (!settle()) return out;
      device.failures += 1;
      if (device.failures >= LOCK_AFTER_FAILURES && device.lockedUntil <= at) {
        device.lockedUntil = at + IP_LOCK_MS;
        out.ipLocked = true;
      }
      spray.failures += 1;
      if (
        spray.failures >= IP_SPRAY_LOCK_AFTER_FAILURES &&
        spray.lockedUntil <= at
      ) {
        spray.lockedUntil = at + IP_LOCK_MS;
        out.deviceLocked = true;
      }
      if (account) {
        account.failures += 1;
        if (
          account.failures >= ACCOUNT_LOCK_AFTER_FAILURES &&
          account.lockedUntil <= at
        ) {
          account.lockedUntil = at + ACCOUNT_LOCK_MS;
          out.accountLocked = true;
        }
      }
      // Back off on whichever budget is most used: a guesser rotating
      // devices still slows down on the account.
      const worst = Math.max(device.failures, account?.failures ?? 0);
      out.delayMs = Math.min(DELAY_MAX_MS, worst * DELAY_STEP_MS);
      out.attemptsLeft = Math.max(0, LOCK_AFTER_FAILURES - device.failures);
      return out;
    },
  };
}

/** Test seam. */
export function __resetLanLoginThrottleForTests(): void {
  byDevice.clear();
  byAccount.clear();
  byIp.clear();
}
