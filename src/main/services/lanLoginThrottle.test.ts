import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_LOCK_AFTER_FAILURES,
  ACCOUNT_LOCK_MS,
  DELAY_MAX_MS,
  DELAY_STEP_MS,
  FAIL_WINDOW_MS,
  IP_LOCK_MS,
  IP_SPRAY_LOCK_AFTER_FAILURES,
  LOCK_AFTER_FAILURES,
  __resetLanLoginThrottleForTests,
  beginLanLoginAttempt,
  lanLoginAccountLockedFor,
  lanLoginDeviceLockedFor,
  lanLoginIpLockedFor,
} from './lanLoginThrottle';

const T0 = 1_790_000_000_000;

function failOnce(ip: string, userId: number, now = T0) {
  const a = beginLanLoginAttempt(ip, userId, now);
  if (!a.ok) throw new Error('unexpectedly locked');
  return a.fail(now);
}

describe('LAN login throttle', () => {
  beforeEach(() => __resetLanLoginThrottleForTests());

  it('slows each miss down, capped', () => {
    expect(failOnce('10.0.0.5', 7).delayMs).toBe(DELAY_STEP_MS);
    let last = 0;
    for (let i = 0; i < LOCK_AFTER_FAILURES - 2; i++) {
      last = failOnce('10.0.0.6', 7, T0 + i).delayMs;
    }
    expect(last).toBe(
      Math.min(DELAY_MAX_MS, (LOCK_AFTER_FAILURES - 1) * DELAY_STEP_MS),
    );
  });

  it('checks exactly the limit when 30 guesses arrive at once', () => {
    // All 30 reserve before any answer comes back, as parallel requests do.
    const attempts = Array.from({ length: 30 }, () =>
      beginLanLoginAttempt('10.0.0.5', 7, T0),
    );
    const checked = attempts.filter((a) => a.ok);
    expect(checked).toHaveLength(LOCK_AFTER_FAILURES);
    for (const a of checked) if (a.ok) a.fail(T0);
    expect(lanLoginDeviceLockedFor('10.0.0.5', 7, T0)).toBe(IP_LOCK_MS);
    expect(beginLanLoginAttempt('10.0.0.5', 7, T0 + 1).ok).toBe(false);
  });

  it('reports attempts left on this device', () => {
    expect(failOnce('10.0.0.5', 7).attemptsLeft).toBe(LOCK_AFTER_FAILURES - 1);
    expect(failOnce('10.0.0.5', 7).attemptsLeft).toBe(LOCK_AFTER_FAILURES - 2);
  });

  it('locks one account on one device and leaves other staff on it alone', () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) {
      expect(failOnce('10.0.0.5', 7, T0 + i).ipLocked).toBe(false);
    }
    expect(failOnce('10.0.0.5', 7, T0 + 100).ipLocked).toBe(true);
    expect(lanLoginDeviceLockedFor('10.0.0.5', 7, T0 + 100)).toBe(IP_LOCK_MS);
    // A colleague on the same tablet still signs in.
    expect(lanLoginDeviceLockedFor('10.0.0.5', 8, T0 + 100)).toBe(0);
    expect(beginLanLoginAttempt('10.0.0.5', 8, T0 + 100).ok).toBe(true);
    // The locked waiter on another device is not locked yet.
    expect(lanLoginDeviceLockedFor('10.0.0.9', 7, T0 + 100)).toBe(0);
    expect(lanLoginDeviceLockedFor('10.0.0.5', 7, T0 + 100 + IP_LOCK_MS)).toBe(
      0,
    );
  });

  it('forgets misses spread out over a shift', () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) failOnce('10.0.0.5', 7);
    const later = T0 + FAIL_WINDOW_MS + 1;
    expect(failOnce('10.0.0.5', 7, later).ipLocked).toBe(false);
  });

  it('a correct PIN clears the account on that device', () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) failOnce('10.0.0.5', 7);
    const a = beginLanLoginAttempt('10.0.0.5', 7, T0);
    expect(a.ok).toBe(true);
    if (a.ok) a.succeed();
    expect(failOnce('10.0.0.5', 7).ipLocked).toBe(false);
  });

  it('locks any account (waiters too) across devices', () => {
    let locked = false;
    for (let i = 0; i < ACCOUNT_LOCK_AFTER_FAILURES; i++) {
      const r = failOnce(`10.0.1.${i}`, 7);
      expect(r.ipLocked).toBe(false);
      locked = r.accountLocked;
    }
    expect(locked).toBe(true);
    expect(lanLoginAccountLockedFor(7, T0)).toBe(ACCOUNT_LOCK_MS);
    expect(lanLoginAccountLockedFor(8, T0)).toBe(0);
    expect(beginLanLoginAttempt('10.0.2.1', 7, T0).ok).toBe(false);
  });

  it('locks a device that walks through every account', () => {
    let locked = false;
    for (let i = 0; i < IP_SPRAY_LOCK_AFTER_FAILURES; i++) {
      locked = failOnce('10.0.0.5', 100 + i).deviceLocked;
    }
    expect(locked).toBe(true);
    expect(lanLoginIpLockedFor('10.0.0.5', T0)).toBe(IP_LOCK_MS);
  });

  it('a released reservation is not counted', () => {
    for (let i = 0; i < 20; i++) {
      const a = beginLanLoginAttempt('10.0.0.5', 7, T0);
      if (a.ok) a.release();
    }
    expect(lanLoginDeviceLockedFor('10.0.0.5', 7, T0)).toBe(0);
  });

  it('pairing misses (account 0) lock the device for sign-in', () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES; i++) {
      failOnce('10.0.0.5', 0);
    }
    expect(lanLoginIpLockedFor('10.0.0.5', T0)).toBe(IP_LOCK_MS);
  });
});
