import { describe, expect, it } from 'vitest';
import {
  normalizePin,
  promotionNeedsNewPin,
  sanitizePinInput,
  staffPinError,
} from './staffPin';

describe('staffPinError', () => {
  it('lets staff use a single digit or letter', () => {
    expect(staffPinError('7', 'WAITER')).toBeNull();
    expect(staffPinError('a', 'WAITER')).toBeNull();
    expect(staffPinError('B', 'BARTENDER')).toBeNull();
    expect(staffPinError('ab12', 'CASHIER')).toBeNull();
  });

  it('rejects empty, too long or symbol PINs for staff', () => {
    expect(staffPinError('', 'WAITER')).toBe('required');
    expect(staffPinError('   ', 'WAITER')).toBe('required');
    expect(staffPinError('1234567', 'WAITER')).toBe('staffFormat');
    expect(staffPinError('a-1', 'WAITER')).toBe('staffFormat');
  });

  it('keeps admin PINs at 4-6 digits', () => {
    expect(staffPinError('1', 'ADMIN')).toBe('adminDigits');
    expect(staffPinError('abcd', 'ADMIN')).toBe('adminDigits');
    expect(staffPinError('4821', 'ADMIN')).toBeNull();
    expect(staffPinError('482193', 'ADMIN')).toBeNull();
  });

  it('accepts any 1-6 letters/digits at login (no role)', () => {
    expect(staffPinError('x')).toBeNull();
    expect(staffPinError('4821')).toBeNull();
  });
});

describe('normalizePin / sanitizePinInput', () => {
  it('treats letters case-insensitively and leaves digits alone', () => {
    expect(normalizePin(' A ')).toBe('a');
    expect(normalizePin('4821')).toBe('4821');
  });

  it('strips characters the role cannot use', () => {
    expect(sanitizePinInput('a-b 1!', 'WAITER')).toBe('ab1');
    expect(sanitizePinInput('ab12', 'ADMIN')).toBe('12');
    expect(sanitizePinInput('1234567')).toBe('123456');
  });
});

describe('promotionNeedsNewPin', () => {
  it('requires a fresh PIN when staff becomes admin', () => {
    expect(
      promotionNeedsNewPin({
        currentRole: 'WAITER',
        nextRole: 'ADMIN',
        pin: '',
      }),
    ).toBe(true);
    expect(
      promotionNeedsNewPin({
        currentRole: 'WAITER',
        nextRole: 'ADMIN',
        pin: '4821',
      }),
    ).toBe(false);
    expect(
      promotionNeedsNewPin({
        currentRole: 'ADMIN',
        nextRole: 'ADMIN',
        pin: '',
      }),
    ).toBe(false);
    expect(
      promotionNeedsNewPin({
        currentRole: 'WAITER',
        nextRole: undefined,
        pin: '',
      }),
    ).toBe(false);
  });
});
