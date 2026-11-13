import { describe, expect, it } from 'vitest';
import { healthWarningsToNotify, tillHealthWarnings } from './tillHealth';

const now = Date.parse('2026-11-14T12:00:00Z');
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
const GB = 1024 ** 3;

describe('tillHealthWarnings', () => {
  it('says nothing when all is well', () => {
    expect(
      tillHealthWarnings({
        nowMs: now,
        freeBytes: 50 * GB,
        savedElsewhereAt: daysAgo(1),
        clockOffsetMs: 5_000,
      }),
    ).toEqual([]);
  });

  it('warns about a nearly full disk, more loudly when very full', () => {
    const w = tillHealthWarnings({
      nowMs: now,
      freeBytes: 1.5 * GB,
      savedElsewhereAt: daysAgo(1),
      clockOffsetMs: null,
    });
    expect(w).toMatchObject([{ kind: 'disk', level: 'warn' }]);
    expect(
      tillHealthWarnings({
        nowMs: now,
        freeBytes: 0.2 * GB,
        savedElsewhereAt: daysAgo(1),
        clockOffsetMs: null,
      })[0],
    ).toMatchObject({ kind: 'disk', level: 'danger' });
  });

  it('warns when no backup has left the till for a week, or ever', () => {
    expect(
      tillHealthWarnings({
        nowMs: now,
        freeBytes: null,
        savedElsewhereAt: daysAgo(9),
        clockOffsetMs: null,
      })[0].message,
    ).toContain('for 9 days');
    expect(
      tillHealthWarnings({
        nowMs: now,
        freeBytes: null,
        savedElsewhereAt: null,
        installedAt: daysAgo(30),
        clockOffsetMs: null,
      })[0].message,
    ).toContain('ever');
    // A till set up this week is not nagged yet.
    expect(
      tillHealthWarnings({
        nowMs: now,
        freeBytes: null,
        savedElsewhereAt: null,
        installedAt: daysAgo(2),
        clockOffsetMs: null,
      }),
    ).toEqual([]);
  });

  it('warns about a wrong clock', () => {
    expect(
      tillHealthWarnings({
        nowMs: now,
        freeBytes: null,
        savedElsewhereAt: daysAgo(1),
        clockOffsetMs: -5 * 60_000,
      })[0].message,
    ).toContain('5 minutes slow');
  });
});

describe('healthWarningsToNotify', () => {
  it('sends each kind at most once a day', () => {
    const w = [
      { kind: 'disk' as const, level: 'warn' as const, message: 'x' },
      { kind: 'clock' as const, level: 'warn' as const, message: 'y' },
    ];
    expect(
      healthWarningsToNotify(
        w,
        { disk: new Date(now - 3_600_000).toISOString() },
        now,
      ).map((x) => x.kind),
    ).toEqual(['clock']);
  });
});
