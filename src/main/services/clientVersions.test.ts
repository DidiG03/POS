import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_VERSION_WINDOW_MS,
  noteClientVersion,
  olderClients,
  resetClientVersions,
} from './clientVersions';
import { tillHealthWarnings } from './tillHealth';

describe('app versions on till health', () => {
  beforeEach(() => resetClientVersions());

  it('counts devices on older apps, once each, for a day', () => {
    const now = 1_000_000_000;
    noteClientVersion('0.2.113', 'phone-a', now);
    noteClientVersion('0.2.113', 'phone-a', now + 1);
    noteClientVersion('0.2.112', 'phone-b', now);
    noteClientVersion('0.2.115', 'phone-c', now);
    noteClientVersion('garbage', 'phone-d', now);
    expect(olderClients(now + 10, '0.2.115')).toEqual([
      { version: '0.2.112', devices: 1 },
      { version: '0.2.113', devices: 1 },
    ]);
    // A phone that updated is no longer counted.
    noteClientVersion('0.2.115', 'phone-a', now + 20);
    expect(olderClients(now + 30, '0.2.115')).toEqual([
      { version: '0.2.112', devices: 1 },
    ]);
    expect(
      olderClients(now + CLIENT_VERSION_WINDOW_MS + 100, '0.2.115'),
    ).toEqual([]);
  });

  it('warns on the banner and says what to do', () => {
    const [w] = tillHealthWarnings({
      nowMs: Date.now(),
      freeBytes: null,
      savedElsewhereAt: new Date().toISOString(),
      clockOffsetMs: null,
      olderClients: [{ version: '0.2.113', devices: 2 }],
      tillVersion: '0.2.115',
    });
    expect(w).toMatchObject({ kind: 'version', level: 'warn' });
    expect(w.message).toMatch(
      /2 phones or tablets use an app older than this till \(0\.2\.115\): 0\.2\.113 \(2\)/,
    );
    expect(w.message).toMatch(/reprinting receipts/);
  });
});
