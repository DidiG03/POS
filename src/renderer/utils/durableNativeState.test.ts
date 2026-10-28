import { describe, expect, it } from 'vitest';
import { keysToRestore } from './durableNativeState';

describe('keysToRestore', () => {
  it('restores what the WebView lost', () => {
    expect(
      keysToRestore({
        local: { 'pos-session': null, 'pos-ticket': '{"a":1}' },
        localStamp: 100,
        saved: { 'pos-session': '{"user":1}', 'pos-ticket': '{"a":0}' },
        savedStamp: 100,
      }),
    ).toEqual(['pos-session']);
  });
  it('prefers the native copy when it is newer', () => {
    expect(
      keysToRestore({
        local: { 'pos-ticket': 'old' },
        localStamp: 100,
        saved: { 'pos-ticket': 'new' },
        savedStamp: 200,
      }),
    ).toEqual(['pos-ticket']);
  });
  it('keeps the WebView copy when it is as new', () => {
    expect(
      keysToRestore({
        local: { 'pos-ticket': 'cur' },
        localStamp: 300,
        saved: { 'pos-ticket': 'older' },
        savedStamp: 200,
      }),
    ).toEqual([]);
  });
});
