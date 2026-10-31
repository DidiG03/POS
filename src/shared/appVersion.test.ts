import { describe, expect, it } from 'vitest';
import {
  APP_VERSION,
  MIN_WAITER_APP_VERSION,
  appVersionTooOld,
  compareAppVersions,
} from './appVersion';

describe('app version check (QA round 5, #3)', () => {
  it('compares versions numerically', () => {
    expect(compareAppVersions('0.2.98', '0.2.100')).toBeLessThan(0);
    expect(compareAppVersions('0.3.0', '0.2.99')).toBeGreaterThan(0);
    expect(compareAppVersions('v0.2.98', '0.2.98')).toBe(0);
  });

  it('tells apps older than the minimum to update', () => {
    expect(appVersionTooOld('0.2.97')).toBe(true);
    expect(appVersionTooOld('0.2.90')).toBe(true);
    expect(appVersionTooOld(MIN_WAITER_APP_VERSION)).toBe(false);
    expect(appVersionTooOld('0.2.100')).toBe(false);
  });

  it('does not judge a client that sends no version (builds before the header)', () => {
    expect(appVersionTooOld(undefined)).toBe(false);
    expect(appVersionTooOld('')).toBe(false);
    expect(appVersionTooOld('garbage')).toBe(false);
  });

  it('this build is never too old for itself', () => {
    expect(appVersionTooOld(APP_VERSION)).toBe(false);
  });
});
