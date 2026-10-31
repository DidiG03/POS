import { describe, expect, it } from 'vitest';
import { MENU_PRICE_MAX, assertMenuPrice, menuPriceProblem } from './menuPrice';

describe('menu prices (QA round 6, #3 and #5)', () => {
  it('accepts prices to the cent', () => {
    for (const p of [0.01, 1, 3.33, 2.35, 150, 1999.99, MENU_PRICE_MAX]) {
      expect(menuPriceProblem(p)).toBeNull();
    }
    // Floating point noise is not a third decimal: 1.1 + 2.2 is
    // 3.3000000000000003, and 3.33 * 100 is 332.99999999999994.
    expect(menuPriceProblem(1.1 + 2.2)).toBeNull();
    expect(menuPriceProblem(3.33)).toBeNull();
  });

  it('refuses three decimals', () => {
    expect(menuPriceProblem(3.333)).toMatch(/2 decimals/);
  });

  it('refuses 0, negatives, and a trillion', () => {
    expect(menuPriceProblem(0)).toMatch(/more than 0/);
    expect(menuPriceProblem(-1)).toMatch(/more than 0/);
    expect(menuPriceProblem(1_000_000_000_000)).toMatch(/at most/);
  });

  it('refuses missing or non-numeric prices', () => {
    expect(menuPriceProblem(undefined)).toMatch(/Enter a price/);
    expect(menuPriceProblem('')).toMatch(/Enter a price/);
    expect(menuPriceProblem('abc')).toMatch(/number/);
    expect(menuPriceProblem(Number.POSITIVE_INFINITY)).toMatch(/number/);
  });

  it('throws a readable 400 the routes pass on', () => {
    expect(() => assertMenuPrice(3.333)).toThrow(
      expect.objectContaining({
        code: 'INVALID_MENU_PRICE',
        statusCode: 400,
        message: 'The price can have at most 2 decimals.',
      }),
    );
  });
});
