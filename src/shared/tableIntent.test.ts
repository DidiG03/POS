import { describe, expect, it } from 'vitest';
import { ageSinceTap, intentAtFromAge, resolveHostIntent } from './tableIntent';

const NOW = 1_790_000_000_000;

describe('table intent clock', () => {
  it('measures age on the phone and places the tap on the till clock', () => {
    const phoneNow = NOW - 5 * 60_000;
    const tappedAt = phoneNow - 1_000;
    const age = ageSinceTap(tappedAt, phoneNow);
    expect(age).toBe(1_000);
    expect(intentAtFromAge(age, NOW)).toBe(NOW - 1_000);
  });

  it('does not let a phone clock that jumped backward look like the future', () => {
    expect(ageSinceTap(NOW + 10_000, NOW)).toBe(0);
    expect(intentAtFromAge(0, NOW)).toBe(NOW);
  });

  it('prefers the age from a current client over a legacy absolute timestamp', () => {
    expect(
      resolveHostIntent({ intentAgeMs: 4_000, intentAt: NOW + 60_000 }, NOW),
    ).toBe(NOW - 4_000);
  });

  it('still accepts an older client that sent its own clock', () => {
    expect(resolveHostIntent({ intentAt: NOW - 2_000 }, NOW)).toBe(NOW - 2_000);
    expect(resolveHostIntent({}, NOW)).toBeUndefined();
  });
});
