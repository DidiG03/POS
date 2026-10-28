import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: number;
  userId: number;
  type: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
};
let rows: Row[] = [];
let users: Array<{ id: number; role: string; displayName: string }> = [];
const failFind = { on: false };

vi.mock('@db/client', () => ({
  prisma: {
    notification: {
      findFirst: async ({ where }: any) => {
        if (failFind.on) throw new Error('db');
        // Yield so parallel callers interleave like real DB calls.
        await new Promise((r) => setTimeout(r, 1));
        const hits = rows
          .filter(
            (r) =>
              r.userId === where.userId &&
              r.createdAt >= where.createdAt.gte &&
              r.message.startsWith(where.message.startsWith),
          )
          .sort((a, b) => +b.createdAt - +a.createdAt);
        return hits[0] ?? null;
      },
      update: async ({ where, data }: any) => {
        await new Promise((r) => setTimeout(r, 1));
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      create: async ({ data }: any) => {
        await new Promise((r) => setTimeout(r, 1));
        const r = {
          id: rows.length + 1,
          readAt: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(r);
        return r;
      },
    },
    user: {
      findUnique: async ({ where }: any) =>
        users.find((u) => u.id === where.id) ?? null,
      findMany: async () => users.filter((u) => u.role === 'ADMIN'),
    },
  },
}));

import {
  countInWrongPinMessage,
  recordWrongPinAttempt,
  wrongPinMessage,
} from './wrongPinAlert';

describe('wrongPinMessage', () => {
  it('keeps the plain text for a first miss and numbers later ones', () => {
    expect(wrongPinMessage(1)).toBe('Wrong PIN attempt on your account');
    expect(wrongPinMessage(4)).toBe(
      'Wrong PIN attempt on your account (4 in the last 15 minutes)',
    );
    expect(countInWrongPinMessage(wrongPinMessage(4))).toBe(4);
    expect(countInWrongPinMessage(wrongPinMessage(1))).toBe(1);
  });
});

describe('recordWrongPinAttempt', () => {
  beforeEach(() => {
    rows = [];
    failFind.on = false;
    users = [
      { id: 1, role: 'ADMIN', displayName: 'Owner' },
      { id: 7, role: 'WAITER', displayName: 'Ana' },
    ];
  });

  it('collapses 20 parallel misses into one alert that counts to 20', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => recordWrongPinAttempt(7)),
    );
    const own = rows.filter((r) => r.userId === 7);
    expect(own).toHaveLength(1);
    expect(own[0].message).toContain('(20 in the last');
  });

  it('tells admins about wrong PINs on a waiter account, collapsed too', async () => {
    await recordWrongPinAttempt(7);
    await recordWrongPinAttempt(7);
    const admin = rows.filter((r) => r.userId === 1);
    expect(admin).toHaveLength(1);
    expect(admin[0].message).toBe(
      "Wrong PIN attempts on Ana's account (2 in the last 15 minutes)",
    );
  });

  it('marks the collapsed alert unread again', async () => {
    await recordWrongPinAttempt(7);
    rows[0].readAt = new Date();
    await recordWrongPinAttempt(7);
    expect(rows.find((r) => r.userId === 7)!.readAt).toBeNull();
  });

  it('does not copy admins on their own admin account', async () => {
    await recordWrongPinAttempt(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('Wrong PIN attempt on your account');
  });

  it('still records when the lookup fails', async () => {
    failFind.on = true;
    await recordWrongPinAttempt(7);
    expect(rows.some((r) => r.userId === 7)).toBe(true);
  });

  it('ignores an unknown user', async () => {
    await recordWrongPinAttempt(0);
    expect(rows).toHaveLength(0);
  });
});
