/** QA round 6, fiscal: payment types other than cash, card and check. */
import { describe, expect, it } from 'vitest';
import { mapPaymentMethod, paymentTypeMapProblem } from './paymentMethod';
import { assertSettingsPatch } from '../settingsValidation';

describe('mapPaymentMethod', () => {
  it('keeps cash, card and check', () => {
    expect(mapPaymentMethod('cash')).toBe('CASH');
    expect(mapPaymentMethod('CARD')).toBe('CARD');
    expect(mapPaymentMethod('check')).toBe('CHECK');
  });

  it('files synonyms of a tax payment type as that type, not OTHER', () => {
    expect(mapPaymentMethod('CHEQUE')).toBe('CHECK');
    expect(mapPaymentMethod('BANK_TRANSFER')).toBe('TRANSFER');
    expect(mapPaymentMethod('DEBIT_CARD')).toBe('CARD');
    expect(mapPaymentMethod('svoucher')).toBe('SVOUCHER');
    expect(mapPaymentMethod('COMPANY')).toBe('COMPANY');
  });

  it("a gift card or room charge follows the venue's mapping, OTHER until set", () => {
    expect(mapPaymentMethod('GIFT_CARD')).toBe('OTHER');
    expect(mapPaymentMethod('ROOM_CHARGE')).toBe('OTHER');
    const settings = {
      fiscal: {
        paymentTypeMap: { GIFT_CARD: 'svoucher', ROOM_CHARGE: 'COMPANY' },
      },
    };
    expect(mapPaymentMethod('GIFT_CARD', settings)).toBe('SVOUCHER');
    expect(mapPaymentMethod('room_charge', settings)).toBe('COMPANY');
    // A venue mapping that is not a type is ignored rather than filed.
    expect(
      mapPaymentMethod('GIFT_CARD', {
        fiscal: { paymentTypeMap: { GIFT_CARD: 'X' } },
      }),
    ).toBe('OTHER');
  });

  it('a mapping to an unknown type, or to ACCOUNT (needs bank details), is refused on save', () => {
    expect(paymentTypeMapProblem({ GIFT_CARD: 'GIFT' })).toMatch(
      /not a payment type/,
    );
    expect(paymentTypeMapProblem({ ROOM_CHARGE: 'ACCOUNT' })).toMatch(
      /not a payment type/,
    );
    expect(paymentTypeMapProblem({ GIFT_CARD: 'VOUCHER' })).toBeNull();
    expect(() =>
      assertSettingsPatch(
        { fiscal: { paymentTypeMap: { GIFT_CARD: 'GIFT' } } },
        {},
      ),
    ).toThrow(/not a payment type/);
  });
});
