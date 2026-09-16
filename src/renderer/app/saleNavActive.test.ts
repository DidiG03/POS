import { describe, expect, it } from 'vitest';
import { isSaleNavActive } from './saleNavActive';

describe('isSaleNavActive', () => {
  it('does not treat the orders list as the table sale tab', () => {
    expect(isSaleNavActive('/app/orders', true)).toBe(false);
    expect(isSaleNavActive('/app/orders', false)).toBe(false);
  });

  it('keeps tables and the live order ticket active', () => {
    expect(isSaleNavActive('/app/tables', true)).toBe(true);
    expect(isSaleNavActive('/app/order', true)).toBe(true);
    expect(isSaleNavActive('/app/order', false)).toBe(true);
    expect(isSaleNavActive('/app/reports', true)).toBe(false);
  });
});
