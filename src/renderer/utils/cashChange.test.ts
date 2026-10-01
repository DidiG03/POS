import { describe, expect, it } from 'vitest';
import { cashChange, parseCashInput, quickCashAmounts } from './cashChange';

describe('parseCashInput', () => {
  it('reads plain, grouped and decimal amounts', () => {
    expect(parseCashInput('1000')).toBe(1000);
    expect(parseCashInput('1.000')).toBe(1000);
    expect(parseCashInput('1 000')).toBe(1000);
    expect(parseCashInput('10.000.000')).toBe(10000000);
    expect(parseCashInput('12,5')).toBe(12.5);
    expect(parseCashInput('20.50')).toBe(20.5);
    expect(parseCashInput('1.234,50')).toBe(1234.5);
  });

  it('returns null for empty or unreadable input', () => {
    expect(parseCashInput('')).toBeNull();
    expect(parseCashInput('abc')).toBeNull();
    expect(parseCashInput('-5')).toBeNull();
  });
});

describe('cashChange', () => {
  it('gives the change when the customer pays more', () => {
    expect(cashChange(500, 1000)).toEqual({ change: 500, short: 0 });
    expect(cashChange(6.2, 10)).toEqual({ change: 3.8, short: 0 });
  });

  it('says how much is missing when the customer pays less', () => {
    expect(cashChange(500, 300)).toEqual({ change: 0, short: 200 });
  });

  it('shows nothing until an amount is typed', () => {
    expect(cashChange(500, null)).toBeNull();
    expect(cashChange(500, 0)).toBeNull();
  });
});

describe('quickCashAmounts', () => {
  it('suggests the next round notes above the total', () => {
    expect(quickCashAmounts(500, 'ALL')).toEqual([600, 1000, 2000]);
    expect(quickCashAmounts(1350, 'ALL')).toEqual([1400, 1500, 2000]);
    expect(quickCashAmounts(6, 'EUR')).toEqual([10, 20, 50]);
  });

  it('suggests nothing for an empty bill', () => {
    expect(quickCashAmounts(0, 'ALL')).toEqual([]);
  });
});
