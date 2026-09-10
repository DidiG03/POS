import { describe, expect, it } from 'vitest';
import { mapPaymentMethod } from './paymentMethod';

describe('mapPaymentMethod', () => {
  it('passes through the methods the API names', () => {
    expect(mapPaymentMethod('CASH')).toBe('CASH');
    expect(mapPaymentMethod('card')).toBe('CARD');
    expect(mapPaymentMethod(' Check ')).toBe('CHECK');
  });

  it('does not invent a named type for anything else', () => {
    // ACCOUNT is a real API type, but the POS has no bank-transfer tender,
    // so mapping an unknown method onto it would file a payment the till
    // never took. OTHER is the honest remainder.
    expect(mapPaymentMethod('ACCOUNT')).toBe('OTHER');
    expect(mapPaymentMethod('')).toBe('OTHER');
    expect(mapPaymentMethod('voucher')).toBe('OTHER');
  });
});
