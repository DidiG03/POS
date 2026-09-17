import { describe, expect, it } from 'vitest';
import {
  authorizeCreateUser,
  isFirstAdminLanBootstrap,
} from './createUserAuth';

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
