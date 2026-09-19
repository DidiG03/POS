/**
 * Menu "sold by kg" as it arrives from Prisma, LAN JSON, or a SQLite 0/1.
 * Tablets used to skip the weigh pad when `isKg` was 1 or missing from a
 * cached menu blob that predated the flag.
 */

export function menuItemSoldByKg(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const rec = item as Record<string, unknown>;
  const tags =
    rec.tags && typeof rec.tags === 'object'
      ? (rec.tags as Record<string, unknown>)
      : null;
  return isTruthyKgFlag(rec.isKg) || isTruthyKgFlag(tags?.isKg);
}

function isTruthyKgFlag(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

/** Stale waiter cache from before `isKg` was on the menu DTO. */
export function menuCategoriesMissingKgFlag(categories: unknown): boolean {
  if (!Array.isArray(categories) || categories.length === 0) return false;
  for (const cat of categories) {
    const items = (cat as { items?: unknown })?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (!('isKg' in (item as object))) return true;
    }
  }
  return false;
}

export function withSoldByKgFlags<T extends { items?: unknown[] }>(
  categories: T[],
): T[] {
  return categories.map((cat) => ({
    ...cat,
    items: Array.isArray(cat.items)
      ? cat.items.map((item: any) => ({
          ...item,
          isKg: menuItemSoldByKg(item),
        }))
      : cat.items,
  }));
}
