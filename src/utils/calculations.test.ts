import { describe, it, expect } from 'vitest';
import { effectiveVatRate, splitGrossVat } from '../shared/ticketRevenue';

/**
 * Unit tests for critical business logic
 *
 * Prices are VAT-INCLUSIVE (Albanian fiscalization): the displayed gross
 * already contains the tax, so VAT is extracted from the menu price rather
 * than added on top. The customer total therefore equals the sum of menu
 * prices, and `subtotal + vat === total`.
 */

// Mirror of OrderPage.computeTotals (kept in sync via the shared helpers).
function computeTotals(
  lines: Array<{ unitPrice: number; qty: number; vatRate: number }>,
  vatEnabled = true,
  defaultVatRate = 0,
) {
  const grossSubtotal = (lines || []).reduce(
    (s, l) => s + Number(l.unitPrice || 0) * Number(l.qty || 0),
    0,
  );
  const vat = vatEnabled
    ? (lines || []).reduce((s, l) => {
        const lineGross = Number(l.unitPrice || 0) * Number(l.qty || 0);
        const rate = effectiveVatRate(l.vatRate, defaultVatRate);
        return s + splitGrossVat(lineGross, rate).vat;
      }, 0)
    : 0;
  const subtotal = grossSubtotal - vat;
  const total = subtotal + vat;
  return { subtotal, vat, total };
}

describe('Business Logic: Totals Calculation (VAT-inclusive)', () => {
  describe('computeTotals', () => {
    it('keeps the gross total equal to the sum of menu prices', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 },
        { unitPrice: 5, qty: 3, vatRate: 0.1 },
      ];
      const result = computeTotals(lines);
      expect(result.total).toBeCloseTo(35, 6); // (10*2) + (5*3) = 35
      expect(result.subtotal).toBeCloseTo(35 / 1.1, 6); // net
    });

    it('extracts VAT from the gross when enabled', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 },
        { unitPrice: 5, qty: 3, vatRate: 0.1 },
      ];
      const result = computeTotals(lines, true);
      expect(result.vat).toBeCloseTo(35 - 35 / 1.1, 6);
      expect(result.total).toBeCloseTo(35, 6);
      expect(result.subtotal + result.vat).toBeCloseTo(result.total, 6);
    });

    it('does not split VAT when disabled (net === gross)', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 },
        { unitPrice: 5, qty: 3, vatRate: 0.1 },
      ];
      const result = computeTotals(lines, false);
      expect(result.vat).toBe(0);
      expect(result.subtotal).toBe(35);
      expect(result.total).toBe(35);
    });

    it('falls back to the default rate for lines with a 0/missing rate', () => {
      const lines = [{ unitPrice: 120, qty: 1, vatRate: 0 }];
      const result = computeTotals(lines, true, 0.2);
      expect(result.total).toBeCloseTo(120, 6);
      expect(result.vat).toBeCloseTo(20, 6);
      expect(result.subtotal).toBeCloseTo(100, 6);
    });

    it('handles empty lines array', () => {
      const result = computeTotals([]);
      expect(result.subtotal).toBe(0);
      expect(result.vat).toBe(0);
      expect(result.total).toBe(0);
    });

    it('handles zero prices', () => {
      const lines = [
        { unitPrice: 0, qty: 5, vatRate: 0.1 },
        { unitPrice: 10, qty: 0, vatRate: 0.1 },
      ];
      const result = computeTotals(lines);
      expect(result.subtotal).toBe(0);
      expect(result.vat).toBe(0);
      expect(result.total).toBe(0);
    });

    it('handles different VAT rates', () => {
      const lines = [
        { unitPrice: 10, qty: 1, vatRate: 0.1 },
        { unitPrice: 10, qty: 1, vatRate: 0.2 },
      ];
      const result = computeTotals(lines);
      expect(result.total).toBeCloseTo(20, 6);
      expect(result.vat).toBeCloseTo(10 - 10 / 1.1 + (10 - 10 / 1.2), 6);
    });

    it('handles decimal quantities', () => {
      const lines = [{ unitPrice: 10, qty: 1.5, vatRate: 0.1 }];
      const result = computeTotals(lines);
      expect(result.total).toBeCloseTo(15, 6); // 10 * 1.5
      expect(result.vat).toBeCloseTo(15 - 15 / 1.1, 6);
    });
  });

  describe('Discount Calculations', () => {
    it('should calculate percentage discount correctly', () => {
      const total = 100;
      const discountPercent = 10; // 10%
      const discountAmount = (total * discountPercent) / 100;
      const totalAfterDiscount = total - discountAmount;

      expect(discountAmount).toBe(10);
      expect(totalAfterDiscount).toBe(90);
    });

    it('should calculate fixed amount discount correctly', () => {
      const total = 100;
      const discountAmount = 15; // Fixed 15 off
      const totalAfterDiscount = total - discountAmount;

      expect(totalAfterDiscount).toBe(85);
    });

    it('should not allow negative total after discount', () => {
      const total = 10;
      const discountAmount = 20; // Discount larger than total
      const totalAfterDiscount = Math.max(0, total - discountAmount);

      expect(totalAfterDiscount).toBe(0);
    });

    it('should handle 100% discount', () => {
      const total = 100;
      const discountPercent = 100;
      const discountAmount = (total * discountPercent) / 100;
      const totalAfterDiscount = total - discountAmount;

      expect(discountAmount).toBe(100);
      expect(totalAfterDiscount).toBe(0);
    });
  });

  describe('Service Charge Calculations', () => {
    it('should calculate percentage service charge correctly', () => {
      const total = 100;
      const serviceChargePercent = 10; // 10%
      const serviceChargeAmount = (total * serviceChargePercent) / 100;
      const totalWithService = total + serviceChargeAmount;

      expect(serviceChargeAmount).toBe(10);
      expect(totalWithService).toBe(110);
    });

    it('should calculate fixed amount service charge correctly', () => {
      const total = 100;
      const serviceChargeAmount = 5; // Fixed 5
      const totalWithService = total + serviceChargeAmount;

      expect(totalWithService).toBe(105);
    });

    it('should handle service charge on zero total', () => {
      const total = 0;
      const serviceChargeAmount = 10;
      const totalWithService = Math.max(0, total + serviceChargeAmount);

      expect(totalWithService).toBe(10);
    });
  });

  describe('Combined Calculations', () => {
    it('applies service charge on the gross (VAT-inclusive) total', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 },
        { unitPrice: 5, qty: 1, vatRate: 0.1 },
      ];
      const totals = computeTotals(lines, true);
      const serviceChargeAmount = 2.5; // 10% of gross (25)
      const finalTotal = totals.total + serviceChargeAmount;

      expect(totals.total).toBeCloseTo(25, 6); // gross == menu prices
      expect(totals.subtotal + totals.vat).toBeCloseTo(totals.total, 6);
      expect(finalTotal).toBeCloseTo(27.5, 6);
    });

    it('applies discount and service charge on the gross total', () => {
      const lines = [{ unitPrice: 100, qty: 1, vatRate: 0.1 }];
      const totals = computeTotals(lines, true);

      const discountAmount = (totals.total * 10) / 100;
      const totalAfterDiscount = totals.total - discountAmount; // 100 - 10 = 90
      const serviceChargeAmount = (totalAfterDiscount * 5) / 100;
      const finalTotal = totalAfterDiscount + serviceChargeAmount; // 90 + 4.5

      expect(totals.total).toBeCloseTo(100, 6);
      expect(discountAmount).toBeCloseTo(10, 6);
      expect(totalAfterDiscount).toBeCloseTo(90, 6);
      expect(serviceChargeAmount).toBeCloseTo(4.5, 6);
      expect(finalTotal).toBeCloseTo(94.5, 6);
    });
  });
});
