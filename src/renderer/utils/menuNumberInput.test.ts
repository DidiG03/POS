import { describe, expect, it } from 'vitest';
import {
  menuMoneyInput,
  menuNumberKeys,
  menuVatPercentInput,
  vatPercentField,
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

describe('menuVatPercentInput', () => {
  it('reads the field as a percent, with a decimal comma too', () => {
    expect(menuVatPercentInput('20')).toBe(0.2);
    expect(menuVatPercentInput('6,5')).toBe(0.065);
    expect(menuVatPercentInput('1')).toBe(0.01);
    expect(menuVatPercentInput('')).toBe(0);
  });

  it('caps at 100%', () => {
    expect(menuVatPercentInput('250')).toBe(1);
  });
});

describe('vatPercentField', () => {
  it('shows the stored fraction as a percent', () => {
    expect(vatPercentField(0.2)).toBe('20');
    expect(vatPercentField(0.065)).toBe('6.5');
    expect(vatPercentField(0)).toBe('0');
    expect(vatPercentField(undefined)).toBe('');
  });
});

describe('menuNumberKeys', () => {
  it('keeps both separators', () => {
    expect(menuNumberKeys('1,50 €')).toBe('1,50');
  });
});
