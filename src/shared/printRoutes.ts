/**
 * Named print routings: a ticket definition, not a printer config.
 *
 * Each routing has a name, a list of categories, and a target printer.
 * Multiple routings may share a printer and still print as separate
 * ORDER slips. Legacy settings stored `categories: { catId → printerId }`
 * (one merged slip per printer); those maps are expanded into one
 * routing per printer until the admin splits them.
 */

export type PrintRouteDTO = {
  id: string;
  name: string;
  printerId: string;
  categoryIds: string[];
};

export function printRouteKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function newPrintRouteId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `r-${rand}`;
}

function uniqueCategoryIds(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function normalizePrintRoute(
  raw: unknown,
  idx = 0,
): PrintRouteDTO | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim() || `r${idx}`;
  const printerId = String(r.printerId ?? '').trim();
  return {
    id,
    name: String(r.name ?? '').trim(),
    printerId,
    categoryIds: uniqueCategoryIds(r.categoryIds),
  };
}

function routesFromLegacyCategories(
  categories: Record<string, string> | undefined,
  printerNames?: Record<string, string>,
): PrintRouteDTO[] {
  const byPrinter = new Map<string, string[]>();
  for (const [k0, v0] of Object.entries(categories || {})) {
    const categoryId = String(k0 || '').trim();
    const printerId = String(v0 || '').trim();
    if (!categoryId || !printerId) continue;
    if (!byPrinter.has(printerId)) byPrinter.set(printerId, []);
    const list = byPrinter.get(printerId)!;
    if (!list.includes(categoryId)) list.push(categoryId);
  }
  return Array.from(byPrinter.entries()).map(([printerId, categoryIds]) => {
    const named = String(printerNames?.[printerId] || '').trim();
    return {
      id: `legacy:${printerId}`,
      name: named || printerId,
      printerId,
      categoryIds,
    };
  });
}

/**
 * Resolve named routings from settings. `routes[]` is the source of
 * truth when present (including an empty list). Otherwise the legacy
 * category→printer map is grouped into one routing per printer.
 */
export function normalizePrintRoutes(
  routing: unknown,
  opts?: { printerNames?: Record<string, string> },
): PrintRouteDTO[] {
  const blob =
    routing && typeof routing === 'object'
      ? (routing as Record<string, unknown>)
      : {};
  if (Array.isArray(blob.routes)) {
    return blob.routes
      .map((raw, idx) => normalizePrintRoute(raw, idx))
      .filter((r): r is PrintRouteDTO => Boolean(r));
  }
  const categories =
    blob.categories && typeof blob.categories === 'object'
      ? (blob.categories as Record<string, string>)
      : undefined;
  return routesFromLegacyCategories(categories, opts?.printerNames);
}

/** Derived categoryId → printerId map for older readers. */
export function categoryMapFromRoutes(
  routes: PrintRouteDTO[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const route of routes) {
    if (!route.printerId) continue;
    for (const categoryId of route.categoryIds) {
      if (!categoryId || out[categoryId]) continue;
      out[categoryId] = route.printerId;
    }
  }
  return out;
}

export function findPrintRouteForCategory(
  routes: PrintRouteDTO[],
  opts: { categoryId?: number | string | null; categoryName?: string | null },
): PrintRouteDTO | undefined {
  const idKey =
    opts.categoryId != null && String(opts.categoryId).trim() !== ''
      ? String(
          Number.isFinite(Number(opts.categoryId))
            ? Number(opts.categoryId)
            : opts.categoryId,
        ).trim()
      : '';
  const nameKey = printRouteKey(opts.categoryName);
  for (const route of routes) {
    for (const raw of route.categoryIds) {
      const key = String(raw || '').trim();
      if (!key) continue;
      if (idKey && key === idKey) return route;
      if (nameKey && printRouteKey(key) === nameKey) return route;
    }
  }
  return undefined;
}

export function nextPrintRouteName(
  existing: Array<{ name?: string }>,
  label: (n: number) => string,
): string {
  const used = new Set(
    existing.map((r) => String(r.name || '').trim()).filter(Boolean),
  );
  let n = existing.length + 1;
  while (used.has(label(n))) n += 1;
  return label(n);
}
