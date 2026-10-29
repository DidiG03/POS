import bcrypt from 'bcryptjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  admins: [] as any[],
  notes: [] as string[],
}));

vi.mock('@db/client', () => ({
  prisma: {
    user: { findMany: vi.fn(async () => h.admins) },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        h.notes.push(data.message);
        return data;
      }),
    },
  },
}));

import {
  __resetManagerPinForTests,
  ALERT_AFTER_FAILURES,
  LAN_LOCK_AFTER_FAILURES,
  LOCK_AFTER_FAILURES,
  SOURCE_LOCK_MS,
  verifyManagerPin,
} from './managerPin';

let clock = 1_000_000;
const sleeps: number[] = [];
const deps = {
  now: () => clock,
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
};
const tryPin = (pin: string, source = '10.0.0.5', lan = true) =>
  verifyManagerPin({ pin, source, lan }, deps);

beforeAll(async () => {
  h.admins = [
    { id: 1, displayName: 'Boss', pinHash: await bcrypt.hash('4826', 4) },
  ];
});

beforeEach(() => {
  __resetManagerPinForTests();
  h.notes = [];
  sleeps.length = 0;
  clock = 1_000_000;
});

describe('verifyManagerPin', () => {
  it('approves the right PIN', async () => {
    expect(await tryPin('4826')).toEqual({
      ok: true,
      admin: { id: 1, displayName: 'Boss' },
    });
    expect(sleeps).toEqual([]);
  });

  it('slows down every miss', async () => {
    await tryPin('0000');
    await tryPin('0001');
    expect(sleeps).toEqual([250, 500]);
  });

  it('locks a phone after repeated misses, and the right PIN is then not checked', async () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES - 1; i++) {
      expect(await tryPin('0000')).toEqual({
        ok: false,
        attemptsLeft: LOCK_AFTER_FAILURES - 1 - i,
      });
    }
    expect(await tryPin('0000')).toMatchObject({
      ok: false,
      lockedForMs: SOURCE_LOCK_MS,
    });
    expect(await tryPin('4826')).toMatchObject({ ok: false });
    // Another phone is not locked by it.
    expect(await tryPin('4826', '10.0.0.6')).toMatchObject({ ok: true });
    // The lock expires.
    clock += SOURCE_LOCK_MS + 1;
    expect(await tryPin('4826')).toMatchObject({ ok: true });
  });

  it('rotating addresses does not reset the budget', async () => {
    for (let i = 0; i < LAN_LOCK_AFTER_FAILURES; i++) {
      await tryPin('0000', `10.0.1.${i}`);
    }
    expect(await tryPin('4826', '10.0.2.1')).toMatchObject({
      ok: false,
      lockedForMs: expect.any(Number),
    });
    expect(h.notes.some((m) => m.includes('paused'))).toBe(true);
    // The till still approves.
    expect(await tryPin('4826', 'till:1', false)).toMatchObject({ ok: true });
  });

  it('never locks the till, but alerts admins', async () => {
    for (let i = 0; i < ALERT_AFTER_FAILURES; i++) {
      await tryPin('0000', 'till:1', false);
    }
    expect(await tryPin('4826', 'till:1', false)).toMatchObject({ ok: true });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain('Unusual activity');
  });

  it('a malformed PIN counts as a miss', async () => {
    expect(await tryPin('abc')).toEqual({
      ok: false,
      attemptsLeft: LOCK_AFTER_FAILURES - 1,
    });
    expect(sleeps).toEqual([250]);
  });
});
