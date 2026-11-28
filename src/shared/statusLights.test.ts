import { describe, expect, it } from 'vitest';
import {
  aggregateStatusLights,
  newlyRed,
  plainReviewReason,
  type StatusFacts,
} from './statusLights';

const now = Date.parse('2026-11-28T20:00:00Z');
const H = 3_600_000;
const healthy = (): StatusFacts => ({
  now,
  fiscal: {
    enabled: true,
    reachable: true,
    breakerOpen: false,
    reviews: 0,
    queued: 0,
  },
  printers: [
    {
      name: 'Kitchen',
      roles: ['Kitchen'],
      reachable: true,
      retrying: 0,
      failedRecently: 0,
    },
    {
      name: 'Front',
      roles: ['Receipts'],
      reachable: true,
      retrying: 0,
      failedRecently: 0,
    },
  ],
  backup: {
    auto: true,
    lastOkAt: new Date(now - 2 * H).toISOString(),
    lastFailed: false,
    savedElsewhereAt: null,
  },
  devices: { online: 3, older: [], tillVersion: '0.2.116' },
  database: { lastBusyAt: null, freeBytes: 50 * 1024 ** 3 },
});
const level = (f: StatusFacts, key: string) =>
  aggregateStatusLights(f).find((l) => l.key === key)!;

describe('status lights', () => {
  it('all green on a healthy till', () => {
    expect(aggregateStatusLights(healthy()).map((l) => l.level)).toEqual([
      'green',
      'green',
      'green',
      'green',
      'green',
    ]);
  });

  it('a stopped printer turns Printers red and names it', () => {
    const f = healthy();
    f.printers[0].reachable = false;
    f.printers[0].retrying = 2;
    const l = level(f, 'printers');
    expect(l.level).toBe('red');
    expect(l.message).toMatch(/Kitchen/);
    expect(l.details[0]).toMatch(/not answering, 2 waiting/);
    f.printers[0].reachable = true;
    expect(level(f, 'printers').level).toBe('amber');
    f.printers[0].retrying = 0;
    expect(level(f, 'printers').level).toBe('green');
  });

  it('fiscal: red when easyPos is unreachable, amber with reviews, red near the 48 h limit', () => {
    const f = healthy();
    f.fiscal.reachable = false;
    expect(level(f, 'fiscal').level).toBe('red');
    f.fiscal.reachable = true;
    f.fiscal.reviews = 2;
    expect(level(f, 'fiscal')).toMatchObject({
      level: 'amber',
      message: expect.stringMatching(/2 sale/),
    });
    f.fiscal.reviews = 0;
    f.fiscal.queued = 1;
    f.fiscal.oldestQueuedAt = new Date(now - 40 * H).toISOString();
    expect(level(f, 'fiscal').level).toBe('red');
    f.fiscal.enabled = false;
    expect(level(f, 'fiscal').level).toBe('off');
  });

  it('an outdated phone turns Devices amber', () => {
    const f = healthy();
    f.devices.older = [{ version: '0.2.113', devices: 1 }];
    expect(level(f, 'devices')).toMatchObject({
      level: 'amber',
      message: expect.stringMatching(/older app/),
    });
  });

  it('backup: red after a failure, amber after a day, manual copies after a week', () => {
    const f = healthy();
    f.backup.lastFailed = true;
    f.backup.lastError = 'folder missing';
    expect(level(f, 'backup').level).toBe('red');
    f.backup.lastFailed = false;
    f.backup.lastOkAt = new Date(now - 30 * H).toISOString();
    expect(level(f, 'backup').level).toBe('amber');
    f.backup.auto = false;
    f.backup.savedElsewhereAt = new Date(now - 2 * 24 * H).toISOString();
    expect(level(f, 'backup').level).toBe('green');
    f.backup.savedElsewhereAt = null;
    expect(level(f, 'backup').level).toBe('amber');
  });

  it('database: amber after a stall, red when the disk is nearly full', () => {
    const f = healthy();
    f.database.lastBusyAt = new Date(now - 60_000).toISOString();
    expect(level(f, 'database').level).toBe('amber');
    f.database.lastBusyAt = new Date(now - 10 * 60_000).toISOString();
    expect(level(f, 'database').level).toBe('green');
    f.database.freeBytes = 100 * 1024 ** 2;
    expect(level(f, 'database').level).toBe('red');
  });

  it('sounds only for a light that just turned red', () => {
    const a = aggregateStatusLights(healthy());
    const f = healthy();
    f.printers[0].reachable = false;
    const b = aggregateStatusLights(f);
    expect(newlyRed(a, b)).toEqual(['printers']);
    expect(newlyRed(b, b)).toEqual([]);
    expect(newlyRed(null, b)).toEqual([]);
  });

  it('explains review reasons in plain words', () => {
    expect(
      plainReviewReason(
        'rejected',
        'Totali nuk mund të jetë më shumë se 500000.00 ALL',
      ),
    ).toMatch(/legal limit/);
    expect(plainReviewReason('unknown-outcome')).toMatch(
      /Look it up in easyPos/,
    );
  });
});
