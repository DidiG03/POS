/** Largest party a till accepts as one table's guest count. */
export const MAX_COVERS = 500;

/**
 * A guest count as stored: a whole number from 1 to {@link MAX_COVERS}, or
 * null. 1.5 failed the database write (the column is an integer) and 1e9
 * was stored, wrecking spend per guest in Review.
 */
export function validCoversCount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COVERS) return null;
  return n;
}
