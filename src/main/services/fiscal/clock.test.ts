/**
 * QA F9: the daily cash balance used the till's local clock.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetFiscalClock,
  CLOCK_DRIFT_ALERT_MS,
  clockDriftToReport,
  clockOffsetMs,
  fiscalDayKey,
  fiscalNow,
  noteProviderDate,
} from './clock';

beforeEach(() => __resetFiscalClock());

describe('the fiscal day', () => {
  it('is the date in Tirana, whatever zone the till runs in', () => {
    // 23:30 UTC on 28 Oct is 00:30 on 29 Oct in Tirana (CET).
    expect(fiscalDayKey(Date.parse('2026-10-28T23:30:00Z'))).toBe('2026-10-29');
    // 21:30 UTC in summer is 23:30 in Tirana (CEST): still the same day.
    expect(fiscalDayKey(Date.parse('2026-07-01T21:30:00Z'))).toBe('2026-07-01');
    expect(fiscalDayKey(Date.parse('2026-07-01T22:30:00Z'))).toBe('2026-07-02');
  });
});

describe("easyPos' clock corrects the till's", () => {
  it('uses the offset from the Date header', () => {
    const till = Date.parse('2026-10-28T22:50:00Z');
    // The till is 15 minutes slow: easyPos says 23:05.
    noteProviderDate('Wed, 28 Oct 2026 23:05:00 GMT', till - 100, till + 100);
    const offset = clockOffsetMs(till)!;
    expect(Math.abs(offset - 15 * 60_000)).toBeLessThan(1_000);
    // An hour later the till reads 23:50 UTC (00:50 in Tirana); corrected,
    // it is 00:05 UTC, still 29 October in Tirana either way, and the
    // corrected time is what the fiscal day is taken from.
    expect(fiscalNow(till)).toBeGreaterThan(till + 14 * 60_000);
    expect(fiscalDayKey(fiscalNow(till + 60 * 60_000))).toBe('2026-10-29');
  });

  it('ignores a slow round trip, an unreadable header and a stale sample', () => {
    const t = Date.parse('2026-10-28T10:00:00Z');
    noteProviderDate('Wed, 28 Oct 2026 12:00:00 GMT', t, t + 60_000);
    expect(clockOffsetMs(t)).toBeNull();
    noteProviderDate('not a date', t, t + 10);
    expect(clockOffsetMs(t)).toBeNull();
    noteProviderDate('Wed, 28 Oct 2026 10:00:00 GMT', t, t + 10);
    expect(clockOffsetMs(t + 13 * 60 * 60_000)).toBeNull();
    expect(fiscalNow(t + 13 * 60 * 60_000)).toBe(t + 13 * 60 * 60_000);
  });

  it('reports a drift worth fixing, once in a while', () => {
    const t = Date.parse('2026-10-28T10:00:00Z');
    noteProviderDate('Wed, 28 Oct 2026 10:00:20 GMT', t, t + 10);
    expect(clockDriftToReport(t)).toBeNull();
    noteProviderDate('Wed, 28 Oct 2026 10:05:00 GMT', t, t + 10);
    const drift = clockDriftToReport(t);
    expect(drift).toBeGreaterThanOrEqual(CLOCK_DRIFT_ALERT_MS);
    expect(clockDriftToReport(t + 60_000)).toBeNull();
  });
});
