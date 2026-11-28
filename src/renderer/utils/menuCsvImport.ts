/**
 * Import checked menu CSV rows (`@shared/menuCsv`): categories first, then
 * items, matched by name so running it twice changes nothing. Each row's
 * failure is reported by its line, the rest still go in.
 */
import type { MenuCsvRow } from '@shared/menuCsv';

export interface MenuImportApi {
  listCategoriesWithItems(): Promise<
    Array<{
      id: number;
      name: string;
      items?: Array<{ id: number; name: string }>;
    }>
  >;
  createCategory(input: {
    name: string;
    kdsStation?: string | null;
  }): Promise<{ id: number }>;
  createItem(input: {
    categoryId: number;
    name: string;
    price: number;
    vatRate?: number;
    station?: 'KITCHEN' | 'BAR' | 'DESSERT';
    active?: boolean;
  }): Promise<unknown>;
}

export interface MenuImportResult {
  categories: number;
  created: number;
  existing: number;
  failed: Array<{ line: number; message: string }>;
}

const key = (s: string) => s.trim().toLowerCase();

export async function importMenuCsvRows(
  rows: MenuCsvRow[],
  api: MenuImportApi,
): Promise<MenuImportResult> {
  const out: MenuImportResult = {
    categories: 0,
    created: 0,
    existing: 0,
    failed: [],
  };
  const menu = await api.listCategoriesWithItems();
  const catId = new Map<string, number>();
  const items = new Set<string>();
  for (const c of menu) {
    catId.set(key(c.name), c.id);
    for (const it of c.items || []) items.add(`${c.id}|${key(it.name)}`);
  }
  for (const r of rows) {
    let cid = catId.get(key(r.category));
    if (cid == null) {
      try {
        const made = await api.createCategory({
          name: r.category,
          kdsStation: r.station,
        });
        cid = Number(made?.id);
        if (!cid) throw new Error('the till did not return the new category');
        catId.set(key(r.category), cid);
        out.categories += 1;
      } catch (e: any) {
        out.failed.push({
          line: r.line,
          message: `Category "${r.category}": ${e?.message || e}`,
        });
        continue;
      }
    }
    if (items.has(`${cid}|${key(r.name)}`)) {
      out.existing += 1;
      continue;
    }
    try {
      await api.createItem({
        categoryId: cid,
        name: r.name,
        price: r.price,
        ...(r.vatRate != null ? { vatRate: r.vatRate } : {}),
        station: r.station,
        active: true,
      });
      items.add(`${cid}|${key(r.name)}`);
      out.created += 1;
    } catch (e: any) {
      out.failed.push({
        line: r.line,
        message: `"${r.name}": ${e?.message || e}`,
      });
    }
  }
  return out;
}
