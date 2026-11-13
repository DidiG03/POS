import { describe, expect, it } from 'vitest';
import { idleLockMinutes, idleLockProblem, shouldIdleLock } from './idleLock';

describe('idleLockMinutes', () => {
  it('locks after 10 minutes unless the venue chose otherwise', () => {
    expect(idleLockMinutes({})).toBe(10);
    expect(idleLockMinutes({ security: { idleLockMinutes: 5 } })).toBe(5);
    expect(idleLockMinutes({ security: { idleLockMinutes: 0 } })).toBe(0);
    expect(idleLockMinutes({ security: { idleLockMinutes: 7 } })).toBe(10);
  });

  it('refuses a value that is not offered', () => {
    expect(idleLockProblem(undefined)).toBeNull();
    expect(idleLockProblem(0)).toBeNull();
    expect(idleLockProblem(15)).toBeNull();
    expect(idleLockProblem(7)).toMatch(/2, 5, 10, 15, 30/);
  });
});

describe('shouldIdleLock', () => {
  const base = { minutes: 10, lastActivityMs: 0, signedIn: true };
  it('locks once the time has passed with nobody touching it', () => {
    expect(shouldIdleLock({ ...base, nowMs: 9 * 60_000 })).toBe(false);
    expect(shouldIdleLock({ ...base, nowMs: 10 * 60_000 })).toBe(true);
  });
  it('never locks when off or when nobody is signed in', () => {
    expect(shouldIdleLock({ ...base, minutes: 0, nowMs: 1e9 })).toBe(false);
    expect(shouldIdleLock({ ...base, signedIn: false, nowMs: 1e9 })).toBe(
      false,
    );
  });
});
