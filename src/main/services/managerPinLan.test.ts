import bcrypt from 'bcryptjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ admins: [] as any[] }));

vi.mock('@db/client', () => ({
  prisma: {
    user: { findMany: vi.fn(async () => h.admins) },
    notification: { create: vi.fn(async ({ data }: any) => data) },
  },
}));

import { checkManagerPinFromLan } from './managerPinLan';
import { __resetManagerPinForTests, LOCK_AFTER_FAILURES } from './managerPin';
import {
  __resetLanLoginThrottleForTests,
  beginLanLoginAttempt,
  lanLoginIpLockedFor,
} from './lanLoginThrottle';

const phone = '10.0.0.7';
const check = (pin: string, remoteIp = phone, lan = true) =>
  checkManagerPinFromLan({
    pin,
    remoteIp,
    lan,
    sleep: async () => undefined,
  });

beforeAll(async () => {
  h.admins = [
    { id: 1, displayName: 'Boss', pinHash: await bcrypt.hash('4826', 4) },
  ];
});

beforeEach(() => {
  __resetManagerPinForTests();
  __resetLanLoginThrottleForTests();
});

describe('manager PIN from a phone (QA round 4, #4)', () => {
  it('approves the right PIN', async () => {
    expect(await check('4826')).toEqual({
      kind: 'approved',
      admin: { id: 1, displayName: 'Boss' },
    });
  });

  it('a wrong PIN is refused with the attempts left, then the device locks', async () => {
    const first = await check('0000');
    expect(first).toEqual({
      kind: 'wrong-pin',
      attemptsLeft: LOCK_AFTER_FAILURES - 1,
      lockedForMs: 0,
    });
    let last = first;
    for (let i = 1; i < LOCK_AFTER_FAILURES; i++) last = await check('0000');
    // The miss that locks is still a 401, saying so.
    expect(last).toMatchObject({ kind: 'wrong-pin', attemptsLeft: 0 });
    expect((last as any).lockedForMs).toBeGreaterThan(0);
    // Then 429, and the right PIN is not even checked.
    const locked = await check('4826');
    expect(locked.kind).toBe('locked');
    expect((locked as any).lockedForMs).toBeGreaterThan(0);
  });

  it('counts toward the same budget as sign-in', async () => {
    // Misses at the sign-in screen use up the device budget.
    for (let i = 0; i < 5; i++) {
      const a = beginLanLoginAttempt(phone, 0);
      if (a.ok) a.fail();
    }
    const r = await check('0000');
    expect(r).toMatchObject({ kind: 'wrong-pin', attemptsLeft: 4 });
    // And manager-PIN misses lock sign-in on that device.
    for (let i = 0; i < 4; i++) await check('0000');
    expect(lanLoginIpLockedFor(phone)).toBeGreaterThan(0);
  });

  it('never locks the till itself', async () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES + 2; i++) {
      expect(await check('0000', '127.0.0.1', false)).toEqual({
        kind: 'wrong-pin',
        attemptsLeft: null,
        lockedForMs: 0,
      });
    }
    expect((await check('4826', '127.0.0.1', false)).kind).toBe('approved');
  });
});
