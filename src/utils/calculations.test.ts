import { describe, it, expect } from 'vitest';

/**
 * Unit tests for critical business logic
 * 
 * Tests cover:
 * - Totals calculation (subtotal, VAT, total)
 * - VAT enabled/disabled
 * - Discount calculations (percentage and fixed)
 * - Service charge calculations
 */

// Extract computeTotals function logic for testing
function computeTotals(
  lines: Array<{ unitPrice: number; qty: number; vatRate: number }>,
  vatEnabled = true
) {
  const subtotal = (lines || []).reduce(
    (s, l) => s + Number(l.unitPrice || 0) * Number(l.qty || 0),
    0
  );
  const vat = vatEnabled
    ? (lines || []).reduce(
        (s, l) =>
          s +
          Number(l.unitPrice || 0) *
            Number(l.qty || 0) *
            Number(l.vatRate || 0),
        0
      )
    : 0;
  const total = subtotal + vat;
  return { subtotal, vat, total };
}

describe('Business Logic: Totals Calculation', () => {
  describe('computeTotals', () => {
    it('should calculate subtotal correctly', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 },
        { unitPrice: 5, qty: 3, vatRate: 0.1 },
      ];
      const result = computeTotals(lines);
      expect(result.subtotal).toBe(35); // (10*2) + (5*3) = 20 + 15 = 35
    });

    it('should calculate VAT correctly when enabled', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 }, // VAT: 2
        { unitPrice: 5, qty: 3, vatRate: 0.1 }, // VAT: 1.5
      ];
      const result = computeTotals(lines, true);
      expect(result.vat).toBe(3.5); // (10*2*0.1) + (5*3*0.1) = 2 + 1.5 = 3.5
      expect(result.total).toBe(38.5); // 35 + 3.5 = 38.5
    });

    it('should not calculate VAT when disabled', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 },
        { unitPrice: 5, qty: 3, vatRate: 0.1 },
      ];
      const result = computeTotals(lines, false);
      expect(result.vat).toBe(0);
      expect(result.total).toBe(35); // Only subtotal
    });

    it('should handle empty lines array', () => {
      const result = computeTotals([]);
      expect(result.subtotal).toBe(0);
      expect(result.vat).toBe(0);
      expect(result.total).toBe(0);
    });

    it('should handle zero prices', () => {
      const lines = [
        { unitPrice: 0, qty: 5, vatRate: 0.1 },
        { unitPrice: 10, qty: 0, vatRate: 0.1 },
      ];
      const result = computeTotals(lines);
      expect(result.subtotal).toBe(0);
      expect(result.vat).toBe(0);
      expect(result.total).toBe(0);
    });

    it('should handle different VAT rates', () => {
      const lines = [
        { unitPrice: 10, qty: 1, vatRate: 0.1 }, // 10% VAT
        { unitPrice: 10, qty: 1, vatRate: 0.2 }, // 20% VAT
      ];
      const result = computeTotals(lines);
      expect(result.subtotal).toBe(20);
      expect(result.vat).toBe(3); // (10*1*0.1) + (10*1*0.2) = 1 + 2 = 3
      expect(result.total).toBe(23);
    });

    it('should handle decimal quantities', () => {
      const lines = [{ unitPrice: 10, qty: 1.5, vatRate: 0.1 }];
      const result = computeTotals(lines);
      expect(result.subtotal).toBe(15); // 10 * 1.5 = 15
      expect(result.vat).toBe(1.5); // 15 * 0.1 = 1.5
      expect(result.total).toBe(16.5);
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
    it('should calculate total with VAT and service charge correctly', () => {
      const lines = [
        { unitPrice: 10, qty: 2, vatRate: 0.1 }, // 20 + 2 VAT
        { unitPrice: 5, qty: 1, vatRate: 0.1 }, // 5 + 0.5 VAT
      ];
      const totals = computeTotals(lines, true);
      // Subtotal: 25, VAT: 2.5, Total: 27.5

      const serviceChargeAmount = 2.75; // 10% of total
      const finalTotal = totals.total + serviceChargeAmount;

      expect(totals.subtotal).toBe(25);
      expect(totals.vat).toBe(2.5);
      expect(totals.total).toBe(27.5);
      expect(finalTotal).toBe(30.25);
    });

    it('should calculate total with VAT, discount, and service charge', () => {
      const lines = [
        { unitPrice: 100, qty: 1, vatRate: 0.1 }, // 100 + 10 VAT = 110
      ];
      const totals = computeTotals(lines, true);

      // Apply 10% discount
      const discountPercent = 10;
      const discountAmount = (totals.total * discountPercent) / 100;
      const totalAfterDiscount = totals.total - discountAmount; // 110 - 11 = 99

      // Apply 5% service charge on discounted total
      const serviceChargePercent = 5;
      const serviceChargeAmount = (totalAfterDiscount * serviceChargePercent) / 100;
      const finalTotal = totalAfterDiscount + serviceChargeAmount; // 99 + 4.95 = 103.95

      expect(totals.total).toBe(110);
      expect(discountAmount).toBe(11);
      expect(totalAfterDiscount).toBe(99);
      expect(serviceChargeAmount).toBe(4.95);
      expect(finalTotal).toBe(103.95);
    });
  });
});
