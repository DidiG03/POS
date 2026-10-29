/**
 * Manager-PIN approval, shared by the till (IPC) and phones (LAN API).
 *
 * The two paths used to carry their own copy of this check, and the LAN copy
 * only raised an hourly alert on misses: a signed-in waiter could walk the
 * 10,000 four-digit admin PINs from a phone and approve their own voids.
 *
 *   - Every miss adds a short delay, which costs a person nothing.
 *   - From the network, `LOCK_AFTER_FAILURES` misses from one source inside
 *     the window lock that source out of approvals for `SOURCE_LOCK_MS`, and
 *     `LAN_LOCK_AFTER_FAILURES` misses from all phones together lock phone
 *     approvals for `LAN_LOCK_MS`, so rotating addresses does not reset the
 *     budget. The till itself is never locked: a manager standing at the
 *     counter can always approve.
 *   - `ALERT_AFTER_FAILURES` misses from one source notify every admin, at
 *     most once per `ALERT_COOLDOWN_MS`.
 *
 * While locked, the PIN is not checked at all, so a lockout cannot be used
 * to learn whether a guess was right.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '@db/client';

export const FAIL_WINDOW_MS = 10 * 60_000;
export const LOCK_AFTER_FAILURES = 8;
export const SOURCE_LOCK_MS = 5 * 60_000;
export const LAN_LOCK_AFTER_FAILURES = 30;
export const LAN_LOCK_MS = 15 * 60_000;
export const ALERT_AFTER_FAILURES = 10;
export const ALERT_COOLDOWN_MS = 60 * 60_000;
export const DELAY_STEP_MS = 250;
export const DELAY_MAX_MS = 2_000;
/** Counters kept before stale ones are pruned. */
const MAX_TRACKED_SOURCES = 1_000;

type Counter = {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  lastAlertAt: number;
};

const bySource = new Map<string, Counter>();
const lanWide: Counter = {
  failures: 0,
  windowStart: 0,
  lockedUntil: 0,
  lastAlertAt: 0,
};

function fresh(c: Counter, now: number): Counter {
  if (c.lockedUntil <= now && now - c.windowStart > FAIL_WINDOW_MS) {
    c.failures = 0;
    c.windowStart = now;
    c.lockedUntil = 0;
  }
  return c;
}

function counterFor(source: string, now: number): Counter {
  let c = bySource.get(source);
  if (!c) {
    if (bySource.size >= MAX_TRACKED_SOURCES) pruneStale(now);
    c = { failures: 0, windowStart: now, lockedUntil: 0, lastAlertAt: 0 };
    bySource.set(source, c);
  }
  return fresh(c, now);
}

function pruneStale(now: number): void {
  for (const [key, c] of bySource) {
    const idle =
      c.lockedUntil <= now &&
      now - c.windowStart > FAIL_WINDOW_MS &&
      now - c.lastAlertAt > ALERT_COOLDOWN_MS;
    if (idle) bySource.delete(key);
  }
}

export type ManagerPinApproval = { id: number; displayName: string };

export type ManagerPinResult =
  | { ok: true; admin: ManagerPinApproval }
  | {
      ok: false;
      lockedForMs?: number;
      /** From the network: misses left before this source is locked. */
      attemptsLeft?: number;
    };

export interface VerifyManagerPinInput {
  pin: unknown;
  /** Who is trying: the phone's IP, or the till window. */
  source: string;
  /** Came over the network (lockouts apply), not from the till. */
  lan: boolean;
}

export interface VerifyManagerPinDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Milliseconds approvals from this source are locked for, or 0. */
export function managerPinLockedFor(
  source: string,
  lan: boolean,
  now = Date.now(),
): number {
  if (!lan) return 0;
  const own = bySource.get(source);
  return Math.max(
    own && own.lockedUntil > now ? own.lockedUntil - now : 0,
    lanWide.lockedUntil > now ? lanWide.lockedUntil - now : 0,
  );
}

async function alertAdmins(
  admins: Array<{ id: number }>,
  message: string,
): Promise<void> {
  for (const a of admins) {
    await prisma.notification
      .create({
        data: { userId: a.id, type: 'SECURITY' as any, message } as any,
      })
      .catch(() => {});
  }
}

export async function verifyManagerPin(
  input: VerifyManagerPinInput,
  deps: VerifyManagerPinDeps = {},
): Promise<ManagerPinResult> {
  const now = (deps.now ?? Date.now)();
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const source = String(input.source || 'unknown');

  const lockedForMs = managerPinLockedFor(source, input.lan, now);
  if (lockedForMs > 0) return { ok: false, lockedForMs };

  const pin = String(input.pin ?? '').trim();
  const admins = (await prisma.user
    .findMany({
      where: { role: 'ADMIN', active: true },
      orderBy: { id: 'asc' },
    })
    .catch(() => [])) as Array<{
    id: number;
    displayName: string;
    pinHash: string | null;
  }>;

  // Admin PINs are 4-6 digits; anything else cannot match, but still counts
  // as a miss so the format check is not a free probe.
  if (/^\d{4,6}$/.test(pin)) {
    for (const u of admins) {
      const ok = await bcrypt
        .compare(pin, String(u.pinHash || ''))
        .catch(() => false);
      if (ok) {
        const c = bySource.get(source);
        if (c) {
          c.failures = 0;
          c.windowStart = now;
        }
        return { ok: true, admin: { id: u.id, displayName: u.displayName } };
      }
    }
  }

  const c = counterFor(source, now);
  c.failures += 1;
  if (input.lan && c.failures >= LOCK_AFTER_FAILURES && c.lockedUntil <= now) {
    c.lockedUntil = now + SOURCE_LOCK_MS;
  }
  if (input.lan) {
    fresh(lanWide, now);
    lanWide.failures += 1;
    if (
      lanWide.failures >= LAN_LOCK_AFTER_FAILURES &&
      lanWide.lockedUntil <= now
    ) {
      lanWide.lockedUntil = now + LAN_LOCK_MS;
      await alertAdmins(
        admins,
        `Manager PIN approvals from phones are paused for ${Math.round(LAN_LOCK_MS / 60_000)} minutes after ${lanWide.failures} wrong PINs. Approvals at the till still work.`,
      );
    }
  }
  if (
    c.failures >= ALERT_AFTER_FAILURES &&
    (!c.lastAlertAt || now - c.lastAlertAt > ALERT_COOLDOWN_MS)
  ) {
    c.lastAlertAt = now;
    const from = input.lan ? ` from ${source}` : '';
    await alertAdmins(
      admins,
      `Unusual activity (auto-check): ${c.failures} manager PIN verification failures in the last ${Math.round(FAIL_WINDOW_MS / 60_000)} minutes${from}. ` +
        'This can be normal (mistyped PINs); please review if unexpected.',
    );
  }

  await sleep(Math.min(DELAY_MAX_MS, c.failures * DELAY_STEP_MS));
  const nowLocked = managerPinLockedFor(source, input.lan, now);
  const attemptsLeft = input.lan
    ? { attemptsLeft: Math.max(0, LOCK_AFTER_FAILURES - c.failures) }
    : {};
  return nowLocked > 0
    ? { ok: false, lockedForMs: nowLocked, ...attemptsLeft }
    : { ok: false, ...attemptsLeft };
}

/** Test seam. */
export function __resetManagerPinForTests(): void {
  bySource.clear();
  lanWide.failures = 0;
  lanWide.windowStart = 0;
  lanWide.lockedUntil = 0;
  lanWide.lastAlertAt = 0;
}
