import { ALL_KDS_STATIONS } from '@shared/kdsStations';

export { ALL_KDS_STATIONS };

export type KdsRoutingMaps = {
  categoryIdToKdsStation: Record<number, string | null>;
  skuToKdsStation: Record<string, string | null>;
};

export function buildKdsRoutingMaps(
  categories: Array<{ id: number; kdsStation?: string | null }>,
  menuItems: Array<{ sku: string; categoryId: number }>,
): KdsRoutingMaps {
  const categoryIdToKdsStation: Record<number, string | null> = {};
  for (const c of categories) {
    categoryIdToKdsStation[c.id] = c.kdsStation
      ? String(c.kdsStation).toUpperCase()
      : null;
  }
  const skuToKdsStation: Record<string, string | null> = {};
  for (const item of menuItems) {
    const sku = String(item.sku || '').trim();
    if (!sku) continue;
    skuToKdsStation[sku] = categoryIdToKdsStation[item.categoryId] ?? null;
  }
  return { categoryIdToKdsStation, skuToKdsStation };
}

export async function loadKdsRoutingFromDb(
  prisma: any,
): Promise<KdsRoutingMaps> {
  const [categories, menuItems] = await Promise.all([
    prisma.category.findMany({ select: { id: true, kdsStation: true } }),
    prisma.menuItem.findMany({ select: { sku: true, categoryId: true } }),
  ]);
  return buildKdsRoutingMaps(categories, menuItems);
}

/** Resolve KDS station from the menu category link; omit unlinked categories. */
export function decorateKdsTicketItemsFromCategory(
  lines: any[],
  routing: KdsRoutingMaps,
): any[] {
  const out: any[] = [];
  for (const it of Array.isArray(lines) ? lines : []) {
    const sku = String(it?.sku || '').trim();
    const catId = Number(it?.categoryId);
    let station: string | null = null;
    if (Number.isFinite(catId) && catId > 0) {
      station = routing.categoryIdToKdsStation[catId] ?? null;
    }
    if (!station && sku) {
      station = routing.skuToKdsStation[sku] ?? null;
    }
    if (!station) continue;
    out.push({ ...it, station });
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
