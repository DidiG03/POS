import { describe, expect, it } from 'vitest';
import {
  menuMoneyInput,
  menuNumberKeys,
  menuVatInput,
} from './menuNumberInput';

describe('menuMoneyInput', () => {
  it('reads a decimal comma', () => {
    expect(menuMoneyInput('1,50')).toBe(1.5);
    expect(menuMoneyInput('12,5')).toBe(12.5);
  });

  it('keeps a comma that groups thousands', () => {
    expect(menuMoneyInput('1,500')).toBe(1500);
    expect(menuMoneyInput('1.234,50')).toBe(1234.5);
    expect(menuMoneyInput('1,234.50')).toBe(1234.5);
  });

  it('never reads a dot as thousands (the form is seeded that way)', () => {
    expect(menuMoneyInput('1.125')).toBe(1.125);
    expect(menuMoneyInput('350')).toBe(350);
  });

  it('treats empty or junk as zero', () => {
    expect(menuMoneyInput('')).toBe(0);
    expect(menuMoneyInput('.')).toBe(0);
  });
});

describe('menuVatInput', () => {
  it('accepts a fraction, a decimal comma or a percent', () => {
    expect(menuVatInput('0.2')).toBe(0.2);
    expect(menuVatInput('0,06')).toBe(0.06);
    expect(menuVatInput('20')).toBe(0.2);
    expect(menuVatInput('')).toBe(0);
  });
});

describe('menuNumberKeys', () => {
  it('keeps both separators', () => {
    expect(menuNumberKeys('1,50 €')).toBe('1,50');
  });
});
