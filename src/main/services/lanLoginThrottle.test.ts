import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_LOCK_AFTER_FAILURES,
  ADMIN_LOCK_MS,
  DELAY_MAX_MS,
  DELAY_STEP_MS,
  FAIL_WINDOW_MS,
  IP_LOCK_MS,
  LOCK_AFTER_FAILURES,
  __resetLanLoginThrottleForTests,
  clearLanLoginFailures,
  lanLoginAdminLockedFor,
  lanLoginIpLockedFor,
  recordLanLoginFailure,
} from './lanLoginThrottle';

const T0 = 1_790_000_000_000;

describe('LAN login throttle', () => {
  beforeEach(() => __resetLanLoginThrottleForTests());

  it('slows each miss down, capped', () => {
    expect(recordLanLoginFailure('10.0.0.5', {}, T0).delayMs).toBe(
      DELAY_STEP_MS,
    );
    let last = 0;
    for (let i = 0; i < 20; i++) {
      last = recordLanLoginFailure('10.0.0.6', {}, T0 + i).delayMs;
    }
    expect(last).toBe(DELAY_MAX_MS);
  });

  it('locks one device after repeated misses without touching others', () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) {
      expect(recordLanLoginFailure('10.0.0.5', {}, T0 + i).ipLocked).toBe(
        false,
      );
    }
    expect(lanLoginIpLockedFor('10.0.0.5', T0 + 100)).toBe(0);
    expect(recordLanLoginFailure('10.0.0.5', {}, T0 + 100).ipLocked).toBe(true);
    expect(lanLoginIpLockedFor('10.0.0.5', T0 + 100)).toBe(IP_LOCK_MS);
    expect(lanLoginIpLockedFor('10.0.0.9', T0 + 100)).toBe(0);
    expect(lanLoginIpLockedFor('10.0.0.5', T0 + 100 + IP_LOCK_MS)).toBe(0);
  });

  it('forgets misses spread out over a shift', () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) {
      recordLanLoginFailure('10.0.0.5', {}, T0);
    }
    const later = T0 + FAIL_WINDOW_MS + 1;
    expect(recordLanLoginFailure('10.0.0.5', {}, later).ipLocked).toBe(false);
    expect(lanLoginIpLockedFor('10.0.0.5', later)).toBe(0);
  });

  it('a correct PIN clears the device', () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) {
      recordLanLoginFailure('10.0.0.5', {}, T0);
    }
    clearLanLoginFailures('10.0.0.5');
    expect(recordLanLoginFailure('10.0.0.5', {}, T0).ipLocked).toBe(false);
  });

  it('locks an admin account across IPs, so rotating addresses does not help', () => {
    let locked = false;
    for (let i = 0; i < ADMIN_LOCK_AFTER_FAILURES; i++) {
      // A new address every attempt never trips the per-IP lock.
      const r = recordLanLoginFailure(`10.0.1.${i}`, { adminUserId: 1 }, T0);
      expect(r.ipLocked).toBe(false);
      locked = r.adminLocked;
    }
    expect(locked).toBe(true);
    expect(lanLoginAdminLockedFor(1, T0)).toBe(ADMIN_LOCK_MS);
    expect(lanLoginAdminLockedFor(2, T0)).toBe(0);
  });

  it('a successful sign-in elsewhere does not reset the admin budget', () => {
    for (let i = 0; i < ADMIN_LOCK_AFTER_FAILURES - 1; i++) {
      recordLanLoginFailure(`10.0.1.${i}`, { adminUserId: 1 }, T0);
    }
    clearLanLoginFailures('10.0.2.1');
    expect(
      recordLanLoginFailure('10.0.1.200', { adminUserId: 1 }, T0).adminLocked,
    ).toBe(true);
  });
});
