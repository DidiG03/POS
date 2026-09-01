import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearLanTokenMemory,
  lanAuthGeneration,
  lanDedupeKey,
  readLanToken,
  shouldForceLogoutOn401,
  writeLanToken,
} from './lanAuthToken';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem(key: string) {
      return data[key] ?? null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    removeItem(key: string) {
      delete data[key];
    },
    snapshot: data,
  };
}

describe('lanAuthToken', () => {
  beforeEach(() => {
    clearLanTokenMemory();
  });

  it('keeps a token in memory when localStorage throws', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    writeLanToken('pos_api_token', 'jwt-live', broken);
    expect(readLanToken('pos_api_token', broken)).toBe('jwt-live');
  });

  it('hydrates memory from storage on first read', () => {
    const storage = memoryStorage({ pos_api_token: 'from-disk' });
    expect(readLanToken('pos_api_token', storage)).toBe('from-disk');
    storage.removeItem('pos_api_token');
    expect(readLanToken('pos_api_token', storage)).toBe('from-disk');
  });

  it('does not logout when a stale 401 arrives after a fresh login', () => {
    expect(shouldForceLogoutOn401(401, 'old-jwt', 'new-jwt')).toBe(false);
    expect(shouldForceLogoutOn401(401, 'new-jwt', 'new-jwt')).toBe(true);
    expect(shouldForceLogoutOn401(401, 'gone', null)).toBe(true);
    expect(shouldForceLogoutOn401(403, 'jwt', 'jwt')).toBe(false);
    expect(shouldForceLogoutOn401(401, null, 'jwt')).toBe(false);
  });

  it('does not logout when the auth generation advanced mid-request', () => {
    expect(
      shouldForceLogoutOn401(401, 'jwt', 'jwt', { request: 1, current: 2 }),
    ).toBe(false);
    expect(
      shouldForceLogoutOn401(401, 'jwt', 'jwt', { request: 2, current: 2 }),
    ).toBe(true);
  });

  it('bumps generation when the live token changes', () => {
    const before = lanAuthGeneration();
    writeLanToken('pos_api_token', 'a');
    const afterLogin = lanAuthGeneration();
    writeLanToken('pos_api_token', 'b');
    expect(afterLogin).toBeGreaterThan(before);
    expect(lanAuthGeneration()).toBeGreaterThan(afterLogin);
  });

  it('does not coalesce GETs that used different bearers', () => {
    expect(lanDedupeKey('GET', '/notifications', 'aaa')).not.toBe(
      lanDedupeKey('GET', '/notifications', 'bbb'),
    );
  });
});
