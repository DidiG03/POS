import { describe, expect, it } from 'vitest';
import {
  isHostUnreachable,
  isLinkDegraded,
  lanBases,
  pollIntervalMs,
  recordFailure,
  recordSuccess,
  resetFailStreak,
  setPreferredScheme,
} from './netQuality';

describe('netQuality', () => {
  it('does not treat a single timeout as a dead host', () => {
    resetFailStreak();
    recordFailure();
    expect(isLinkDegraded()).toBe(false);
    expect(isHostUnreachable()).toBe(false);
  });

  it('marks the link degraded after a burst of failures', () => {
    resetFailStreak();
    recordFailure();
    recordFailure();
    recordFailure();
    expect(isLinkDegraded()).toBe(true);
    expect(isHostUnreachable()).toBe(true);
  });

  it('backs off polling when the link is degraded', () => {
    resetFailStreak();
    recordFailure();
    recordFailure();
    recordFailure();
    expect(pollIntervalMs(4000)).toBeGreaterThanOrEqual(12_000);
  });

  it('skips HTTPS once HTTP has been proven to work', () => {
    setPreferredScheme('http');
    expect(lanBases('http://a', 'https://b')).toEqual(['http://a']);
  });

  it('recovers after a success', () => {
    resetFailStreak();
    recordFailure();
    recordFailure();
    recordFailure();
    recordSuccess(40);
    expect(isLinkDegraded()).toBe(false);
    expect(isHostUnreachable()).toBe(false);
  });
});
