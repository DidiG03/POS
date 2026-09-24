import { ALL_KDS_STATIONS } from '@shared/kdsStations';

export { ALL_KDS_STATIONS };

/**
 * Master KDS switch. Missing/`true` keeps kitchen routing on so existing
 * installs don't go dark. Explicit `false` turns the whole KDS off.
 */
export function kdsMasterEnabledFromSettings(settings: unknown): boolean {
  return (settings as any)?.kds?.enabled !== false;
}

/**
 * Which prep stations are enabled for KDS routing, read from settings.
 * Shape: `settings.kds.stations = { KITCHEN: boolean, BAR: boolean, DESSERT:
 * boolean }`. A station is enabled unless it's explicitly set to `false`, so
 * existing installs (no setting yet) keep routing to every station.
 * When the master switch is off, this is empty — nothing is fanned out.
 */
export function enabledStationsFromSettings(settings: unknown): Set<string> {
  const enabled = new Set<string>();
  if (!kdsMasterEnabledFromSettings(settings)) return enabled;
  const map = (settings as any)?.kds?.stations;
  for (const st of ALL_KDS_STATIONS) {
    if (!map || map[st] !== false) enabled.add(st);
  }
  return enabled;
}

export type KdsRoutingMaps = {
  categoryIdToKdsStation: Record<number, string | null>;
  categoryIdToSortOrder: Record<number, number>;
  skuToKdsStation: Record<string, string | null>;
  skuToCategoryId: Record<string, number>;
};

/**
 * Rank matching the admin menu list: `sortOrder` ascending, then `id`.
 * Raw `sortOrder` alone is not enough — installs often leave every
 * category at the default `0`, and the UI still shows a stable order by id.
 */
export function buildCategoryDisplayOrder(
  categories: Array<{ id: number; sortOrder?: number | null }>,
): Record<number, number> {
  const ordered = [...(Array.isArray(categories) ? categories : [])].sort(
    (a, b) => {
      const ao = Number(a.sortOrder);
      const bo = Number(b.sortOrder);
      const aOk = Number.isFinite(ao);
      const bOk = Number.isFinite(bo);
      if (aOk && bOk && ao !== bo) return ao - bo;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return Number(a.id) - Number(b.id);
    },
  );
  const out: Record<number, number> = {};
  ordered.forEach((c, index) => {
    const id = Number(c.id);
    if (Number.isFinite(id)) out[id] = index;
  });
  return out;
}

export function buildKdsRoutingMaps(
  categories: Array<{
    id: number;
    kdsStation?: string | null;
    sortOrder?: number;
  }>,
  menuItems: Array<{ sku: string; categoryId: number }>,
): KdsRoutingMaps {
  const categoryIdToKdsStation: Record<number, string | null> = {};
  for (const c of categories) {
    categoryIdToKdsStation[c.id] = c.kdsStation
      ? String(c.kdsStation).toUpperCase()
      : null;
  }
  const categoryIdToSortOrder = buildCategoryDisplayOrder(categories);
  const skuToKdsStation: Record<string, string | null> = {};
  const skuToCategoryId: Record<string, number> = {};
  for (const item of menuItems) {
    const sku = String(item.sku || '').trim();
    if (!sku) continue;
    const categoryId = Number(item.categoryId);
    skuToKdsStation[sku] = categoryIdToKdsStation[categoryId] ?? null;
    if (Number.isFinite(categoryId) && categoryId > 0) {
      skuToCategoryId[sku] = categoryId;
    }
  }
  return {
    categoryIdToKdsStation,
    categoryIdToSortOrder,
    skuToKdsStation,
    skuToCategoryId,
  };
}

export async function loadKdsRoutingFromDb(
  prisma: any,
): Promise<KdsRoutingMaps> {
  const [categories, menuItems] = await Promise.all([
    prisma.category.findMany({
      select: { id: true, kdsStation: true, sortOrder: true },
    }),
    prisma.menuItem.findMany({ select: { sku: true, categoryId: true } }),
  ]);
  return buildKdsRoutingMaps(categories, menuItems);
}

/** Fill missing `categoryId` from the live menu SKU map so sort/routing
 * still follow the admin category order when lines only carry a SKU. */
export function enrichItemsWithCategoryId(
  items: any[],
  skuToCategoryId: Record<string, number>,
): any[] {
  return (Array.isArray(items) ? items : []).map((it) => {
    const existing = Number(it?.categoryId);
    if (Number.isFinite(existing) && existing > 0) return it;
    const sku = String(it?.sku || '').trim();
    const fromSku = sku ? Number(skuToCategoryId[sku]) : NaN;
    if (Number.isFinite(fromSku) && fromSku > 0) {
      return { ...it, categoryId: fromSku };
    }
    return it;
  });
}

/** Sort ticket lines by the admin-defined category order (then name),
 * without reordering lines whose category is unavailable. */
export function sortKdsItemsByCategoryOrder(
  items: any[],
  categoryIdToSortOrder: Record<number, number>,
): any[] {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aOrder = categoryIdToSortOrder[Number(a.item?.categoryId)];
      const bOrder = categoryIdToSortOrder[Number(b.item?.categoryId)];
      const aKnown = Number.isFinite(aOrder);
      const bKnown = Number.isFinite(bOrder);
      if (aKnown && bKnown && aOrder !== bOrder) return aOrder - bOrder;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      const byName = String(a.item?.name || '').localeCompare(
        String(b.item?.name || ''),
        undefined,
        { sensitivity: 'base' },
      );
      if (byName !== 0) return byName;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/** Resolve KDS station from the menu category link; omit unlinked categories. */
export function decorateKdsTicketItemsFromCategory(
  lines: any[],
  routing: KdsRoutingMaps,
): any[] {
  const out: any[] = [];
  for (const it of Array.isArray(lines) ? lines : []) {
    const sku = String(it?.sku || '').trim();
    let catId = Number(it?.categoryId);
    if (!(Number.isFinite(catId) && catId > 0) && sku) {
      const fromSku = Number(routing.skuToCategoryId?.[sku]);
      if (Number.isFinite(fromSku) && fromSku > 0) catId = fromSku;
    }
    let station: string | null = null;
    if (Number.isFinite(catId) && catId > 0) {
      station = routing.categoryIdToKdsStation[catId] ?? null;
    }
    if (!station && sku) {
      station = routing.skuToKdsStation[sku] ?? null;
    }
    if (!station) continue;
    out.push({
      ...it,
      ...(Number.isFinite(catId) && catId > 0 ? { categoryId: catId } : null),
      station,
    });
  }
  return out;
}

export function kdsStationsWithActiveItems(
  decorated: any[],
  enabledStations: Set<string>,
): string[] {
  return Array.from(
    new Set(
      decorated
        .map((it: any) => String(it?.station || '').toUpperCase())
        .filter((s) => enabledStations.has(s)),
    ),
  );
}
