import { describe, expect, it } from 'vitest';
import { heartbeatDelayMs } from './netQuality';

describe('heartbeatDelayMs', () => {
  it('pings every 5 s while the till answers', () => {
    expect(heartbeatDelayMs(0)).toBe(5_000);
  });
  it('backs off while it is silent, up to 30 s', () => {
    expect([1, 2, 3, 4, 9].map(heartbeatDelayMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000,
    ]);
  });
});
