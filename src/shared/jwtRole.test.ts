import { describe, expect, it } from 'vitest';
import { isHostOrAdminRole, jwtRole } from './jwtRole';

function unsignedJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

describe('jwtRole', () => {
  it('reads the role claim', () => {
    expect(jwtRole(unsignedJwt({ role: 'HOST' }))).toBe('HOST');
    expect(jwtRole(unsignedJwt({ role: 'waiter' }))).toBe('WAITER');
  });

  it('returns empty for garbage', () => {
    expect(jwtRole(null)).toBe('');
    expect(jwtRole('not-a-jwt')).toBe('');
  });
});

describe('isHostOrAdminRole', () => {
  it('accepts host and admin only', () => {
    expect(isHostOrAdminRole('HOST')).toBe(true);
    expect(isHostOrAdminRole('admin')).toBe(true);
    expect(isHostOrAdminRole('WAITER')).toBe(false);
  });
});
