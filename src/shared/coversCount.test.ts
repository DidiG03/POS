import { describe, expect, it } from 'vitest';
import { validCoversCount } from './coversCount';

describe('validCoversCount', () => {
  it('keeps a whole party size', () => {
    expect(validCoversCount(4)).toBe(4);
    expect(validCoversCount('12')).toBe(12);
  });

  it('refuses fractions, zero, negatives and absurd sizes', () => {
    for (const bad of [1.5, 0, -2, 1e9, 'abc', null, undefined]) {
      expect(validCoversCount(bad)).toBeNull();
    }
  });
});
