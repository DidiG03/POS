/**
 * `POST /auth/verify-manager-pin`, answered like `/auth/login`.
 *
 * A wrong manager PIN from a phone used to be HTTP 200 `{ ok: false }`, and
 * its misses only counted against the manager-PIN throttle: a phone locked
 * out of sign-in could keep guessing admin PINs here. Now:
 *   - a wrong PIN is 401 `WRONG_PIN` with `attemptsLeft` (and, once that
 *     miss locked the device, `locked` and `retryAfterMs`);
 *   - a locked device is 429 `LOGIN_LOCKED` with `retryAfterMs`, and the PIN
 *     is not checked;
 *   - each miss counts as an unknown-account sign-in miss from the device
 *     (`lanLoginThrottle.ts`), so login and approvals share one budget.
 * The till itself (loopback) is never throttled.
 */
import {
  beginLanLoginAttempt,
  lanLoginIpLockedFor,
  type LanLoginFailure,
} from './lanLoginThrottle';
import {
  managerPinLockedFor,
  verifyManagerPin,
  type ManagerPinApproval,
} from './managerPin';

export type ManagerPinLanAnswer =
  | { kind: 'approved'; admin: ManagerPinApproval }
  | {
      kind: 'wrong-pin';
      /** Null from the till itself. */
      attemptsLeft: number | null;
      lockedForMs: number;
    }
  | { kind: 'locked'; lockedForMs: number };

export async function checkManagerPinFromLan(input: {
  pin: unknown;
  remoteIp: string;
  /** False for the till itself (loopback). */
  lan: boolean;
  /** Alerts and the pause after a miss (`failLanLogin`). */
  onFail?: (outcome: LanLoginFailure) => Promise<void>;
  /** Refused unchecked because the device is locked. */
  onLocked?: () => void;
  /** Test seam: the till's pause after a miss. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<ManagerPinLanAnswer> {
  const { remoteIp, lan } = input;
  let attempt: ReturnType<typeof beginLanLoginAttempt> | null = null;
  if (lan) {
    const lockedFor = Math.max(
      lanLoginIpLockedFor(remoteIp),
      managerPinLockedFor(remoteIp, true),
    );
    if (lockedFor > 0) {
      input.onLocked?.();
      return { kind: 'locked', lockedForMs: lockedFor };
    }
    attempt = beginLanLoginAttempt(remoteIp, 0);
    if (!attempt.ok)
      return { kind: 'locked', lockedForMs: attempt.lockedForMs };
  }
  let result: Awaited<ReturnType<typeof verifyManagerPin>>;
  try {
    result = await verifyManagerPin(
      { pin: input.pin, source: remoteIp, lan },
      // From phones the pause is `onFail`'s.
      { sleep: lan ? async () => undefined : input.sleep },
    );
  } catch (e) {
    if (attempt?.ok) attempt.release();
    throw e;
  }
  if (result.ok) {
    // Not `succeed`: a right PIN must not wipe this device's earlier misses
    // (pairing, unknown accounts) from the shared budget.
    if (attempt?.ok) attempt.release();
    return { kind: 'approved', admin: result.admin };
  }
  if (!attempt?.ok) {
    return { kind: 'wrong-pin', attemptsLeft: null, lockedForMs: 0 };
  }
  const outcome = attempt.fail();
  await input.onFail?.(outcome);
  return {
    kind: 'wrong-pin',
    attemptsLeft: Math.min(
      outcome.attemptsLeft,
      result.attemptsLeft ?? outcome.attemptsLeft,
    ),
    lockedForMs: Math.max(
      result.lockedForMs ?? 0,
      lanLoginIpLockedFor(remoteIp),
    ),
  };
}
