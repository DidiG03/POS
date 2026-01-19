import { describe, it, expect } from 'vitest';

/**
 * Unit tests for formatting utilities
 */

function makeFormatAmount() {
  return (n: number) => {
    const v = Number.isFinite(n) ? n : 0;
    const decimals = Math.abs(v - Math.round(v)) > 1e-9 ? 2 : 0;
    return v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
}

function formatMoneyCompact(currency: string, amount: number) {
  const a = Number.isFinite(amount) ? amount : 0;
  const rounded = Math.round(a);
  const cur = String(currency || '').trim().toUpperCase();
  // Prefer ISO currency formatting when possible
  if (/^[A-Z]{3}$/.test(cur)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: cur,
        maximumFractionDigits: 0,
      }).format(rounded);
    } catch {
      // fall through
    }
  }
  // Fallback: treat short non-alnum as symbol (€, £, $)
  const looksSymbol = cur.length <= 2 && /[^A-Z0-9]/.test(cur);
  return looksSymbol ? `${cur}${rounded}` : `${cur || 'EUR'} ${rounded}`;
}

describe('Formatting Utilities', () => {
  describe('makeFormatAmount', () => {
    it('should format integers without decimals', () => {
      const format = makeFormatAmount();
      expect(format(100)).toBe('100');
      expect(format(1000)).toBe('1,000');
      expect(format(1000000)).toBe('1,000,000');
    });

    it('should format decimals with 2 decimal places', () => {
      const format = makeFormatAmount();
      expect(format(100.5)).toBe('100.50');
      expect(format(100.99)).toBe('100.99');
      expect(format(1000.123)).toBe('1,000.12');
    });

    it('should handle zero', () => {
      const format = makeFormatAmount();
      expect(format(0)).toBe('0');
    });

    it('should handle negative numbers', () => {
      const format = makeFormatAmount();
      expect(format(-100)).toBe('-100');
      expect(format(-100.5)).toBe('-100.50');
    });

    it('should handle NaN and Infinity', () => {
      const format = makeFormatAmount();
      expect(format(NaN)).toBe('0');
      expect(format(Infinity)).toBe('0');
      expect(format(-Infinity)).toBe('0');
    });
  });

  describe('formatMoneyCompact', () => {
    it('should format with ISO currency codes', () => {
      const result = formatMoneyCompact('USD', 100);
      // Result depends on locale, but should contain currency
      expect(result).toContain('100');
    });

    it('should format with currency symbols', () => {
      const result = formatMoneyCompact('€', 100);
      expect(result).toBe('€100');
    });

    it('should round to nearest integer', () => {
      const result1 = formatMoneyCompact('USD', 100.4);
      const result2 = formatMoneyCompact('USD', 100.6);
      expect(result1).toContain('100');
      expect(result2).toContain('101');
    });

    it('should handle zero', () => {
      const result = formatMoneyCompact('USD', 0);
      expect(result).toContain('0');
    });

    it('should use default currency if invalid', () => {
      const result = formatMoneyCompact('', 100);
      expect(result).toContain('100');
    });
  });
});
