import { describe, expect, it } from 'vitest';
import {
  MIN_SITTING_LOOKBACK_MS,
  noteSittingSettings,
  sittingLookbackFor,
  sittingLookbackMs,
} from './sittingLimit';

const H = 60 * 60 * 1000;

describe('sittingLookback', () => {
  it('keeps 13 hours for venues on the default', () => {
    expect(sittingLookbackFor({})).toBe(MIN_SITTING_LOOKBACK_MS);
    expect(MIN_SITTING_LOOKBACK_MS).toBe(13 * H);
  });

  it('follows a venue that lets tables stay open longer', () => {
    expect(
      sittingLookbackFor({ preferences: { overdueTables: { hours: 36 } } }),
    ).toBe(37 * H);
  });

  it('never goes below 13 hours', () => {
    expect(
      sittingLookbackFor({ preferences: { overdueTables: { hours: 2 } } }),
    ).toBe(13 * H);
  });

  it('is what the settings last said', () => {
    noteSittingSettings({ preferences: { overdueTables: { hours: 72 } } });
    expect(sittingLookbackMs()).toBe(73 * H);
    noteSittingSettings({});
    expect(sittingLookbackMs()).toBe(13 * H);
  });
});
