/**
 * VAT band mapping.
 *
 * Filing 10% VAT as 20% is a tax error that nothing downstream can catch,
 * so the interesting cases here are the boundaries and the unit confusion.
 */

import { describe, expect, it } from 'vitest';
import { mapVatRateToCode } from './vat';

describe('mapVatRateToCode', () => {
  it('maps the Albanian bands from fractions', () => {
    expect(mapVatRateToCode(0.2)).toBe('B');
    expect(mapVatRateToCode(0.1)).toBe('D');
    expect(mapVatRateToCode(0.06)).toBe('E');
    expect(mapVatRateToCode(0)).toBe('A');
  });

  it('reads a whole number as a percentage instead of a huge fraction', () => {
    // Every one of these would have landed in the 20% band before, because
    // they all clear the `>= 0.19` threshold.
    expect(mapVatRateToCode(20)).toBe('B');
    expect(mapVatRateToCode(10)).toBe('D');
    expect(mapVatRateToCode(6)).toBe('E');
  });

  it('treats an absent or nonsense rate as exempt', () => {
    expect(mapVatRateToCode(NaN)).toBe('A');
    expect(mapVatRateToCode(-1)).toBe('A');
    expect(mapVatRateToCode(undefined as unknown as number)).toBe('A');
  });

  it('holds the band boundaries', () => {
    expect(mapVatRateToCode(0.19)).toBe('B');
    expect(mapVatRateToCode(0.189)).toBe('D');
    expect(mapVatRateToCode(0.09)).toBe('D');
    expect(mapVatRateToCode(0.089)).toBe('E');
    expect(mapVatRateToCode(0.05)).toBe('E');
    expect(mapVatRateToCode(0.049)).toBe('A');
  });
});
