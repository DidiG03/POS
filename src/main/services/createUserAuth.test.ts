import { describe, expect, it } from 'vitest';
import { authorizeLanRoute } from './lanPolicy';
import {
  authorizeCreateUser,
  isFirstAdminLanBootstrap,
} from './createUserAuth';

/** Mirrors the LAN token gate + handler checks in `api.ts`. */
function lanCreateUserStatus(input: {
  userCount: number;
  sessionRole: string | null;
  requestedRole: string;
}): number {
  const firstAdmin = isFirstAdminLanBootstrap(
    'POST',
    '/auth/create-user',
    input.userCount,
  );
  const role = firstAdmin ? null : input.sessionRole;
  if (!firstAdmin && !role) return 401;
  const verdict = authorizeLanRoute('POST', '/auth/create-user', role, {
    userCount: input.userCount,
  });
  if (verdict === 'unauthenticated') return 401;
  if (verdict !== 'allow') return 403;
  const create = authorizeCreateUser({
    userCount: input.userCount,
    sessionRole: role,
    requestedRole: input.requestedRole,
  });
  return create.allow ? 200 : 403;
}

describe('isFirstAdminLanBootstrap', () => {
  it('matches only POST /auth/create-user on an empty user table', () => {
    expect(isFirstAdminLanBootstrap('POST', '/auth/create-user', 0)).toBe(true);
    expect(isFirstAdminLanBootstrap('post', '/auth/create-user', 0)).toBe(true);
    expect(isFirstAdminLanBootstrap('POST', '/auth/create-user', 1)).toBe(
      false,
    );
    expect(isFirstAdminLanBootstrap('GET', '/auth/create-user', 0)).toBe(false);
    expect(isFirstAdminLanBootstrap('POST', '/auth/users', 0)).toBe(false);
  });
});

describe('authorizeCreateUser', () => {
  it('allows the first user only when it is an ADMIN', () => {
    expect(
      authorizeCreateUser({
        userCount: 0,
        sessionRole: null,
        requestedRole: 'ADMIN',
      }),
    ).toEqual({ allow: true });
    expect(
      authorizeCreateUser({
        userCount: 0,
        requestedRole: 'WAITER',
      }),
    ).toEqual({ allow: false, reason: 'bootstrap_requires_admin' });
  });

  it('requires an ADMIN session after the first user exists', () => {
    expect(
      authorizeCreateUser({
        userCount: 1,
        sessionRole: 'ADMIN',
        requestedRole: 'WAITER',
      }),
    ).toEqual({ allow: true });
    expect(
      authorizeCreateUser({
        userCount: 1,
        sessionRole: null,
        requestedRole: 'ADMIN',
      }),
    ).toEqual({ allow: false, reason: 'admin_session_required' });
    expect(
      authorizeCreateUser({
        userCount: 2,
        sessionRole: 'WAITER',
        requestedRole: 'CASHIER',
      }),
    ).toEqual({ allow: false, reason: 'admin_session_required' });
  });
});

describe('LAN first-admin create (client Unauthorised regression)', () => {
  it('accepts Create admin from OneTap Admin when the till has no users', () => {
    expect(
      lanCreateUserStatus({
        userCount: 0,
        sessionRole: null,
        requestedRole: 'ADMIN',
      }),
    ).toBe(200);
  });

  it('ignores a leftover waiter JWT during bootstrap', () => {
    expect(
      lanCreateUserStatus({
        userCount: 0,
        sessionRole: 'WAITER',
        requestedRole: 'ADMIN',
      }),
    ).toBe(200);
  });

  it('rejects bootstrapping a waiter as the first user', () => {
    expect(
      lanCreateUserStatus({
        userCount: 0,
        sessionRole: null,
        requestedRole: 'WAITER',
      }),
    ).toBe(403);
  });

  it('returns unauthorized after setup if there is no admin session', () => {
    expect(
      lanCreateUserStatus({
        userCount: 1,
        sessionRole: null,
        requestedRole: 'ADMIN',
      }),
    ).toBe(401);
    expect(
      lanCreateUserStatus({
        userCount: 1,
        sessionRole: 'WAITER',
        requestedRole: 'CASHIER',
      }),
    ).toBe(403);
    expect(
      lanCreateUserStatus({
        userCount: 1,
        sessionRole: 'ADMIN',
        requestedRole: 'WAITER',
      }),
    ).toBe(200);
  });
});
