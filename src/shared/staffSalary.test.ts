import { describe, expect, it } from 'vitest';
import {
  parseSalaryAmountInput,
  parseSalaryPeriod,
  salaryFromUser,
  salaryWriteData,
} from './staffSalary';

describe('staffSalary', () => {
  it('parses known periods and rejects junk', () => {
    expect(parseSalaryPeriod('hourly')).toBe('HOURLY');
    expect(parseSalaryPeriod('MONTHLY')).toBe('MONTHLY');
    expect(parseSalaryPeriod('yearly')).toBe('YEARLY');
    expect(parseSalaryPeriod('weekly')).toBeNull();
    expect(parseSalaryPeriod(null)).toBeNull();
  });

  it('parses salary amounts from form text', () => {
    expect(parseSalaryAmountInput('')).toEqual({ ok: true, value: null });
    expect(parseSalaryAmountInput('  ')).toEqual({ ok: true, value: null });
    expect(parseSalaryAmountInput('12.50')).toEqual({ ok: true, value: 12.5 });
    expect(parseSalaryAmountInput('12,50')).toEqual({ ok: true, value: 12.5 });
    expect(parseSalaryAmountInput('0')).toEqual({ ok: true, value: 0 });
    expect(parseSalaryAmountInput('-1').ok).toBe(false);
    expect(parseSalaryAmountInput('abc').ok).toBe(false);
  });

  it('reads stored salary fields', () => {
    expect(
      salaryFromUser({ salaryAmount: 18, salaryPeriod: 'HOURLY' }),
    ).toEqual({
      salaryAmount: 18,
      salaryPeriod: 'HOURLY',
    });
    expect(salaryFromUser({})).toEqual({
      salaryAmount: null,
      salaryPeriod: null,
    });
  });

  it('clears period when amount is empty and defaults period when amount is set', () => {
    expect(salaryWriteData(null, 'YEARLY')).toEqual({
      salaryAmount: null,
      salaryPeriod: null,
    });
    expect(salaryWriteData(2400, null)).toEqual({
      salaryAmount: 2400,
      salaryPeriod: 'MONTHLY',
    });
  });
});
