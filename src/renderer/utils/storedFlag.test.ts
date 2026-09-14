import { describe, expect, it, beforeEach } from 'vitest';
import { readStoredFlag, writeStoredFlag } from './storedFlag';

const mem = new Map<string, string>();

beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
    setItem: (key: string, value: string) => {
      mem.set(key, String(value));
    },
    removeItem: (key: string) => {
      mem.delete(key);
    },
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  };
});

describe('storedFlag', () => {
  it('defaults when nothing is stored', () => {
    expect(readStoredFlag('pos-ui-admin-rail-collapsed')).toBe(false);
  });

  it('round-trips a collapsed choice', () => {
    writeStoredFlag('pos-ui-admin-rail-collapsed', true);
    expect(readStoredFlag('pos-ui-admin-rail-collapsed')).toBe(true);
    writeStoredFlag('pos-ui-admin-rail-collapsed', false);
    expect(readStoredFlag('pos-ui-admin-rail-collapsed')).toBe(false);
  });
});
