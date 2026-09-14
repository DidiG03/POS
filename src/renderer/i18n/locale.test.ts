import { describe, expect, it, beforeEach } from 'vitest';
import {
  normalizeLng,
  readStoredPosUiLang,
  writeStoredPosUiLang,
} from './locale';

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
  (
    globalThis as { document?: { documentElement: { lang: string } } }
  ).document = {
    documentElement: { lang: 'en' },
  };
});

describe('locale storage', () => {
  it('treats anything but sq as English', () => {
    expect(normalizeLng('sq')).toBe('sq');
    expect(normalizeLng('SQ')).toBe('sq');
    expect(normalizeLng('en')).toBe('en');
    expect(normalizeLng('')).toBe('en');
  });

  it('round-trips the waiter language', () => {
    expect(readStoredPosUiLang()).toBe('en');
    writeStoredPosUiLang('sq');
    expect(readStoredPosUiLang()).toBe('sq');
    expect(
      (globalThis as { document: { documentElement: { lang: string } } })
        .document.documentElement.lang,
    ).toBe('sq');
  });
});
