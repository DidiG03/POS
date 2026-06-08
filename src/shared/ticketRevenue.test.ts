import { describe, expect, it } from 'vitest';
import {
  effectiveVatRate,
  splitGrossVat,
  sumTicketLinesNetVat,
} from './ticketRevenue';

describe('effectiveVatRate', () => {
  it('uses the line rate when it is a positive number', () => {
    expect(effectiveVatRate(0.2, 0.06)).toBe(0.2);
  });

  it('falls back to the default when the line rate is missing or zero', () => {
    expect(effectiveVatRate(0, 0.2)).toBe(0.2);
    expect(effectiveVatRate(undefined, 0.2)).toBe(0.2);
    expect(effectiveVatRate(null, 0.2)).toBe(0.2);
  });

  it('returns 0 when neither the line nor the default has a positive rate', () => {
    expect(effectiveVatRate(0, 0)).toBe(0);
    expect(effectiveVatRate(undefined, undefined)).toBe(0);
  });
});

describe('splitGrossVat (VAT-inclusive)', () => {
  it('extracts the contained VAT from a gross amount', () => {
    const { net, vat } = splitGrossVat(120, 0.2);
    expect(net).toBeCloseTo(100, 6);
    expect(vat).toBeCloseTo(20, 6);
  });

  it('treats a 0 rate as VAT-free (net === gross)', () => {
    expect(splitGrossVat(100, 0)).toEqual({ net: 100, vat: 0 });
  });
});

describe('sumTicketLinesNetVat', () => {
  it('excludes voided lines and extracts VAT inclusively', () => {
    const { net, vat } = sumTicketLinesNetVat([
      { name: 'A', qty: 2, unitPrice: 10, vatRate: 0.1 },
      { name: 'B', qty: 1, unitPrice: 5, vatRate: 0, voided: true },
    ]);
    // gross live = 20 @ 10% inclusive
    expect(net).toBeCloseTo(20 / 1.1, 6);
    expect(vat).toBeCloseTo(20 - 20 / 1.1, 6);
  });

  it('returns zeros for empty or invalid itemsJson', () => {
    expect(sumTicketLinesNetVat(null)).toEqual({ net: 0, vat: 0 });
    expect(sumTicketLinesNetVat([])).toEqual({ net: 0, vat: 0 });
  });

  it('skips VAT when vatEnabled is false (net === gross)', () => {
    const { net, vat } = sumTicketLinesNetVat(
      [{ name: 'A', qty: 1, unitPrice: 100, vatRate: 0.2 }],
      false,
    );
    expect(net).toBe(100);
    expect(vat).toBe(0);
  });

  it('falls back to the default rate for lines with a 0/missing rate', () => {
    const { net, vat } = sumTicketLinesNetVat(
      [{ name: 'A', qty: 1, unitPrice: 120, vatRate: 0 }],
      true,
      0.2,
    );
    expect(net).toBeCloseTo(100, 6);
    expect(vat).toBeCloseTo(20, 6);
  });
});
