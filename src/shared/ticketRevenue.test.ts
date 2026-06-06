import { describe, expect, it } from 'vitest';
import { sumTicketLinesNetVat } from './ticketRevenue';

describe('sumTicketLinesNetVat', () => {
  it('excludes voided lines from net and vat', () => {
    const { net, vat } = sumTicketLinesNetVat([
      { name: 'A', qty: 2, unitPrice: 10, vatRate: 0.1 },
      { name: 'B', qty: 1, unitPrice: 5, vatRate: 0, voided: true },
    ]);
    expect(net).toBe(20);
    expect(vat).toBe(2);
  });

  it('returns zeros for empty or invalid itemsJson', () => {
    expect(sumTicketLinesNetVat(null)).toEqual({ net: 0, vat: 0 });
    expect(sumTicketLinesNetVat([])).toEqual({ net: 0, vat: 0 });
  });

  it('skips VAT when vatEnabled is false', () => {
    const { net, vat } = sumTicketLinesNetVat(
      [{ name: 'A', qty: 1, unitPrice: 100, vatRate: 0.2 }],
      false,
    );
    expect(net).toBe(100);
    expect(vat).toBe(0);
  });
});
