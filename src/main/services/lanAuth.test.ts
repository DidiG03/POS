import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, users } = vi.hoisted(() => ({
  store: new Map<string, any>(),
  users: new Map<number, { id: number; role: string; active: boolean }>(),
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: vi.fn(async ({ where }: any) => store.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.get(where.key);
        store.set(where.key, existing ? { ...existing, ...update } : create);
        return store.get(where.key);
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) return null;
        if (where.active === true && !u.active) return null;
        return u;
      }),
    },
  },
}));

import {
  LAN_USER_CACHE_MS,
  __resetLanAuthForTests,
  resolveLanTokenSubject,
  revokeLanTokensForUser,
} from './lanAuth';

const T0 = 1_790_000_000_000;

describe('LAN token subject', () => {
  beforeEach(() => {
    store.clear();
    users.clear();
    __resetLanAuthForTests();
    users.set(1, { id: 1, role: 'ADMIN', active: true });
    users.set(2, { id: 2, role: 'WAITER', active: true });
  });

  it('uses the role in the database, not the one in the token', async () => {
    users.set(1, { id: 1, role: 'WAITER', active: true });
    expect(
      await resolveLanTokenSubject({ userId: 1, issuedAtMs: T0 }, T0),
    ).toEqual({ userId: 1, role: 'WAITER' });
  });

  it('refuses a deactivated or deleted user', async () => {
    users.set(2, { id: 2, role: 'WAITER', active: false });
    expect(
      await resolveLanTokenSubject({ userId: 2, issuedAtMs: T0 }, T0),
    ).toBeNull();
    expect(
      await resolveLanTokenSubject({ userId: 42, issuedAtMs: T0 }, T0),
    ).toBeNull();
  });

  it('refuses tokens issued before a revocation, accepts a fresh sign-in', async () => {
    await revokeLanTokensForUser(2, T0 + 1_000);
    expect(
      await resolveLanTokenSubject({ userId: 2, issuedAtMs: T0 }, T0 + 2_000),
    ).toBeNull();
    expect(
      await resolveLanTokenSubject(
        { userId: 2, issuedAtMs: T0 + 1_500 },
        T0 + 2_000,
      ),
    ).toEqual({ userId: 2, role: 'WAITER' });
    // Other users are unaffected.
    expect(
      await resolveLanTokenSubject({ userId: 1, issuedAtMs: T0 }, T0 + 2_000),
    ).toEqual({ userId: 1, role: 'ADMIN' });
  });

  it('survives a restart: the revocation is persisted', async () => {
    await revokeLanTokensForUser(2, T0 + 1_000);
    __resetLanAuthForTests();
    expect(
      await resolveLanTokenSubject({ userId: 2, issuedAtMs: T0 }, T0 + 2_000),
    ).toBeNull();
  });

  it('a revocation is not hidden by the user cache', async () => {
    expect(
      await resolveLanTokenSubject({ userId: 2, issuedAtMs: T0 }, T0),
    ).not.toBeNull();
    users.set(2, { id: 2, role: 'WAITER', active: false });
    await revokeLanTokensForUser(2, T0 + 10);
    expect(
      await resolveLanTokenSubject({ userId: 2, issuedAtMs: T0 + 20 }, T0 + 30),
    ).toBeNull();
  });

  it('picks up a role change once the short cache expires', async () => {
    await resolveLanTokenSubject({ userId: 1, issuedAtMs: T0 }, T0);
    users.set(1, { id: 1, role: 'CASHIER', active: true });
    expect(
      await resolveLanTokenSubject(
        { userId: 1, issuedAtMs: T0 },
        T0 + LAN_USER_CACHE_MS + 1,
      ),
    ).toEqual({ userId: 1, role: 'CASHIER' });
  });

  it('closes the live event streams of a revoked user', async () => {
    const endA = vi.fn();
    const endB = vi.fn();
    const clients = new Set<any>([
      { userId: 2, res: { end: endA } },
      { userId: 1, res: { end: endB } },
    ]);
    (globalThis as any).__SSE_CLIENTS__ = clients;
    await revokeLanTokensForUser(2, T0);
    expect(endA).toHaveBeenCalled();
    expect(endB).not.toHaveBeenCalled();
    expect(clients.size).toBe(1);
    delete (globalThis as any).__SSE_CLIENTS__;
  });
});
