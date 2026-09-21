import { describe, expect, it } from 'vitest';
import {
  canSeeKdsOnMobile,
  canSeeReportsOnMobile,
  isClockOnlyRole,
} from './roles';

describe('canSeeReportsOnMobile', () => {
  it('lets waiters, cashiers and admins open personal reports on a phone', () => {
    expect(canSeeReportsOnMobile('WAITER')).toBe(true);
    expect(canSeeReportsOnMobile('cashier')).toBe(true);
    expect(canSeeReportsOnMobile('ADMIN')).toBe(true);
  });

  it('keeps kitchen and clock-only roles off the reports tab', () => {
    expect(canSeeReportsOnMobile('CHEF')).toBe(false);
    expect(canSeeReportsOnMobile('HOST')).toBe(false);
    expect(canSeeReportsOnMobile(null)).toBe(false);
  });
});

describe('canSeeKdsOnMobile', () => {
  it('is kitchen staff only', () => {
    expect(canSeeKdsOnMobile('CHEF')).toBe(true);
    expect(canSeeKdsOnMobile('WAITER')).toBe(false);
  });
});

describe('isClockOnlyRole', () => {
  it('does not treat waiters as clock-only', () => {
    expect(isClockOnlyRole('WAITER')).toBe(false);
    expect(isClockOnlyRole('CHEF')).toBe(true);
  });
});
