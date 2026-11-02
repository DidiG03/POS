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
    expect(mapPaymentMethod('COMPANY')).toBe('COMPANY');
  });

  it("a gift card or room charge follows the venue's mapping, OTHER until set", () => {
    expect(mapPaymentMethod('GIFT_CARD')).toBe('OTHER');
    expect(mapPaymentMethod('ROOM_CHARGE')).toBe('OTHER');
    const settings = {
      fiscal: {
        paymentTypeMap: { GIFT_CARD: 'other', ROOM_CHARGE: 'COMPANY' },
      },
    };
    expect(mapPaymentMethod('GIFT_CARD', settings)).toBe('OTHER');
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
    expect(paymentTypeMapProblem({ GIFT_CARD: 'OTHER' })).toBeNull();
    expect(() =>
      assertSettingsPatch(
        { fiscal: { paymentTypeMap: { GIFT_CARD: 'GIFT' } } },
        {},
      ),
    ).toThrow(/not a payment type/);
  });
});

describe('voucher payment types (QA v0.2.103 #4)', () => {
  it('refuses a voucher mapping on save, saying why', () => {
    for (const t of ['VOUCHER', 'svoucher']) {
      expect(paymentTypeMapProblem({ GIFT_CARD: t })).toMatch(
        /voucher numbers/,
      );
    }
    expect(() =>
      assertSettingsPatch(
        { fiscal: { paymentTypeMap: { GIFT_CARD: 'SVOUCHER' } } },
        {},
      ),
    ).toThrow(/voucher numbers/);
  });

  it('files a voucher mapping saved before this as OTHER, so the sale is accepted', () => {
    const saved = { fiscal: { paymentTypeMap: { GIFT_CARD: 'SVOUCHER' } } };
    expect(mapPaymentMethod('GIFT_CARD', saved)).toBe('OTHER');
    expect(mapPaymentMethod('VOUCHER')).toBe('OTHER');
    expect(mapPaymentMethod('SVOUCHER')).toBe('OTHER');
  });
});
