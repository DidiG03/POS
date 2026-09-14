import { describe, expect, it } from 'vitest';
import {
  printCopy,
  printLangFromSettings,
  printPaymentMethod,
  printStaffLabel,
} from './printCopy';

describe('printCopy', () => {
  it('reads sq from venue preferences and otherwise English', () => {
    expect(printLangFromSettings({ preferences: { language: 'sq' } })).toBe(
      'sq',
    );
    expect(printLangFromSettings({ preferences: { language: 'en' } })).toBe(
      'en',
    );
    expect(printLangFromSettings({})).toBe('en');
  });

  it('translates receipt labels used on the thermal slip', () => {
    const sq = printCopy('sq');
    expect(sq.waiter).toBe('Kamarier');
    expect(sq.cashier).toBe('Kasier');
    expect(sq.covers).toBe('Të ftuar');
    expect(sq.subtotal).toBe('Nëntotali');
    expect(sq.vat).toBe('TVSH');
    expect(sq.paid).toBe('E PAGUAR');
    expect(sq.thankYou).toBe('Faleminderit!');
    expect(sq.note).toBe('Shënim');
    expect(printStaffLabel('sq', true)).toBe('Kamarier');
    expect(printStaffLabel('sq', false)).toBe('Kasier');
    expect(printPaymentMethod('sq', 'CASH')).toBe('PARA');
    expect(printPaymentMethod('sq', 'card')).toBe('KARTË');
  });

  it('keeps English labels when the venue language is English', () => {
    const en = printCopy('en');
    expect(en.waiter).toBe('Waiter');
    expect(en.thankYou).toBe('Thank you!');
    expect(printPaymentMethod('en', 'CASH')).toBe('CASH');
  });
});
