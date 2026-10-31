/**
 * What a menu price may be. Checked by the till when an item is saved
 * (`menuAdmin.ts`) and by the Admin form before it sends one.
 *
 *  - To the cent: a price of 3.333 was filed per unit in lekë and the
 *    invoice no longer matched the receipt (QA round 6, #3).
 *  - More than 0: a free item was filed as a 0 L invoice. A price is
 *    needed; a giveaway is a discount on the bill (QA round 6, #5).
 *  - At most `MENU_PRICE_MAX`: 1,000,000,000,000 was accepted (#5). A
 *    million covers any dish priced in lekë.
 */

export const MENU_PRICE_MAX = 1_000_000;

export const INVALID_MENU_PRICE = 'INVALID_MENU_PRICE';

/** Why `price` cannot be saved, or null when it can. */
export function menuPriceProblem(price: unknown): string | null {
  const n = typeof price === 'number' ? price : Number(price);
  if (price === null || price === undefined || price === '') {
    return 'Enter a price.';
  }
  if (!Number.isFinite(n)) return 'The price must be a number.';
  if (n <= 0) {
    return 'The price must be more than 0. To give an item away, apply a discount on the bill.';
  }
  if (n > MENU_PRICE_MAX) {
    return `The price can be at most ${MENU_PRICE_MAX.toLocaleString('en-US')}.`;
  }
  // Cents only. `n * 100` of a two-decimal price can be 333.00000000000006.
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    return 'The price can have at most 2 decimals.';
  }
  return null;
}

/** Throws a readable error (code `INVALID_MENU_PRICE`) for a bad price. */
export function assertMenuPrice(price: unknown): void {
  const problem = menuPriceProblem(price);
  if (!problem) return;
  throw Object.assign(new Error(problem), {
    code: INVALID_MENU_PRICE,
    statusCode: 400,
  });
}
