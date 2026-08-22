/**
 * Session lifecycle for IPC authorization. Prisma is mocked with a tiny
 * in-memory key/value store standing in for `syncState`, plus a user table, so
 * the suite covers persistence and revocation without a real database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, users } = vi.hoisted(() => ({
  store: new Map<string, any>(),
  users: new Map<
    number,
    { id: number; role: string; displayName: string; active: boolean }
  >(),
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.get(where.key);
        store.set(where.key, existing ? { ...existing, ...update } : create);
        return store.get(where.key);
      }),
      findUnique: vi.fn(async ({ where }: any) => store.get(where.key) ?? null),
      findMany: vi.fn(async ({ where }: any) => {
        const prefix = where?.key?.startsWith ?? '';
        return [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, ...value }));
      }),
      delete: vi.fn(async ({ where }: any) => {
        const existing = store.get(where.key);
        if (!existing) throw new Error('not found');
        store.delete(where.key);
        return existing;
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
  __resetSessionsForTests,
  createSession,
  getSession,
  pruneExpiredSessions,
  registerWindowKind,
  resumeSession,
  revokeSession,
  revokeSessionsForUser,
  unbindSender,
  windowKindFor,
  SESSION_TTL_MS,
} from './ipcSession';

const ADMIN = { id: 1, role: 'ADMIN', displayName: 'Owner', active: true };
const WAITER = { id: 2, role: 'WAITER', displayName: 'Ana', active: true };

beforeEach(() => {
  store.clear();
  users.clear();
  users.set(ADMIN.id, { ...ADMIN });
  users.set(WAITER.id, { ...WAITER });
  __resetSessionsForTests();
  vi.useRealTimers();
});

describe('createSession', () => {
  it('binds the user to the calling window', async () => {
    await createSession(10, ADMIN);
    expect(getSession(10)).toMatchObject({ userId: 1, role: 'ADMIN' });
  });

  it('returns a token that is not stored in the clear', async () => {
    const token = await createSession(10, ADMIN);
    expect(token.length).toBeGreaterThan(20);
    const persisted = JSON.stringify([...store.entries()]);
    expect(persisted).not.toContain(token);
  });

  it('normalises the role to upper case', async () => {
    await createSession(10, { id: 3, role: 'waiter', displayName: 'Lo' });
    expect(getSession(10)?.role).toBe('WAITER');
  });

  it('replaces the previous identity when a window logs in again', async () => {
    const first = await createSession(10, ADMIN);
    await createSession(10, WAITER);
    expect(getSession(10)?.role).toBe('WAITER');
    // The superseded token must not survive as a way back to ADMIN.
    __resetSessionsForTests();
    expect(await resumeSession(11, first)).toBeNull();
  });

  it('gives separate windows separate sessions', async () => {
    await createSession(10, ADMIN);
    await createSession(20, WAITER);
    expect(getSession(10)?.role).toBe('ADMIN');
    expect(getSession(20)?.role).toBe('WAITER');
  });
});

describe('getSession', () => {
  it('returns null for a window nobody logged into', () => {
    expect(getSession(99)).toBeNull();
  });

  it('returns null once the session has aged out', async () => {
    await createSession(10, ADMIN);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    expect(getSession(10)).toBeNull();
  });
});

describe('resumeSession', () => {
  it('rebinds a valid token to a new window', async () => {
    const token = await createSession(10, ADMIN);
    __resetSessionsForTests(); // simulate an app restart
    const resumed = await resumeSession(30, token);
    expect(resumed).toMatchObject({ userId: 1, role: 'ADMIN' });
    expect(getSession(30)?.userId).toBe(1);
  });

  it('rejects an unknown token', async () => {
    expect(await resumeSession(30, 'not-a-real-token')).toBeNull();
  });

  it('rejects an empty token', async () => {
    expect(await resumeSession(30, '')).toBeNull();
  });

  it('rejects a token whose account was deactivated', async () => {
    const token = await createSession(10, WAITER);
    __resetSessionsForTests();
    users.set(WAITER.id, { ...WAITER, active: false });
    expect(await resumeSession(30, token)).toBeNull();
  });

  it('rejects a token whose account was deleted', async () => {
    const token = await createSession(10, WAITER);
    __resetSessionsForTests();
    users.delete(WAITER.id);
    expect(await resumeSession(30, token)).toBeNull();
  });

  it('picks up a role change made since the token was issued', async () => {
    const token = await createSession(10, WAITER);
    __resetSessionsForTests();
    users.set(WAITER.id, { ...WAITER, role: 'CASHIER' });
    const resumed = await resumeSession(30, token);
    expect(resumed?.role).toBe('CASHIER');
  });

  it('refuses an expired token and forgets it', async () => {
    const token = await createSession(10, ADMIN);
    __resetSessionsForTests();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    expect(await resumeSession(30, token)).toBeNull();
    vi.useRealTimers();
    expect(await resumeSession(30, token)).toBeNull();
  });
});

describe('revocation', () => {
  it('revokeSession drops the binding and the token', async () => {
    const token = await createSession(10, ADMIN);
    await revokeSession(10);
    expect(getSession(10)).toBeNull();
    expect(await resumeSession(11, token)).toBeNull();
  });

  it('revokeSessionsForUser clears every window that user holds', async () => {
    await createSession(10, ADMIN);
    await createSession(20, ADMIN);
    await createSession(30, WAITER);
    await revokeSessionsForUser(ADMIN.id);
    expect(getSession(10)).toBeNull();
    expect(getSession(20)).toBeNull();
    expect(getSession(30)?.role).toBe('WAITER');
  });

  it('revokeSessionsForUser also reaches sessions this process never loaded', async () => {
    const token = await createSession(10, WAITER);
    __resetSessionsForTests(); // only the persisted row remains
    await revokeSessionsForUser(WAITER.id);
    expect(await resumeSession(30, token)).toBeNull();
  });
});

describe('unbindSender', () => {
  it('detaches the window but leaves the token resumable', async () => {
    const token = await createSession(10, ADMIN);
    unbindSender(10);
    expect(getSession(10)).toBeNull();
    expect(await resumeSession(11, token)).toMatchObject({ userId: 1 });
  });
});

describe('window kinds', () => {
  it('reports the registered kind', () => {
    registerWindowKind(10, 'kds');
    expect(windowKindFor(10)).toBe('kds');
  });

  it('reports unknown for anything unregistered', () => {
    expect(windowKindFor(12345)).toBe('unknown');
  });

  it('forgets the kind when the window goes away', () => {
    registerWindowKind(10, 'admin');
    unbindSender(10);
    expect(windowKindFor(10)).toBe('unknown');
  });
});

describe('pruneExpiredSessions', () => {
  it('removes aged-out rows and keeps live ones', async () => {
    await createSession(10, ADMIN);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    const liveToken = await createSession(20, WAITER);
    const removed = await pruneExpiredSessions();
    expect(removed).toBeGreaterThan(0);
    expect(getSession(20)?.userId).toBe(WAITER.id);
    vi.useRealTimers();
    // The surviving row is still the live one.
    __resetSessionsForTests();
    users.set(WAITER.id, { ...WAITER });
    expect(await resumeSession(21, liveToken)).not.toBeNull();
  });
});
