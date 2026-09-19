import { prisma } from '@db/client';
import { normalizeProductCode } from '@shared/barcodeScan';
import {
  CreateMenuItemInputSchema,
  UpdateMenuItemInputSchema,
} from '@shared/ipc';
import {
  costWritePayload,
  emptyCostLine,
  parseCostBreakdown,
} from '@shared/itemCost';
import { menuItemSoldByKg } from '@shared/menuItemKg';
import { storePlanBlocksTables } from './license';
import {
  applyDailyStockPatch,
  applyOnHandStockPatch,
  expireStaleMenuStock,
  localCalendarDateKey,
} from './menuStock';

export function normalizeMenuStockLevel(raw: unknown): 'OK' | 'LOW' | 'OUT' {
  const s = String(raw ?? 'OK').toUpperCase();
  if (s === 'LOW') return 'LOW';
  if (s === 'OUT') return 'OUT';
  return 'OK';
}

export function menuItemCostDto(i: {
  costPrice?: unknown;
  costBreakdown?: unknown;
}): {
  costPrice: number | null;
  costBreakdown: { id: string; label: string; amount: number }[] | null;
} {
  const costBreakdown = parseCostBreakdown(i.costBreakdown);
  const fromPrice =
    i.costPrice != null && Number.isFinite(Number(i.costPrice))
      ? Number(i.costPrice)
      : null;
  return {
    costPrice: fromPrice,
    costBreakdown: costBreakdown.length ? costBreakdown : null,
  };
}

export function menuItemCostWrite(input: {
  costPrice?: number | null;
  costBreakdown?: { id: string; label: string; amount: number }[] | null;
}): { costPrice: number | null; costBreakdown: unknown } | null {
  if (input.costBreakdown !== undefined) {
    return costWritePayload(input.costBreakdown ?? []);
  }
  if (input.costPrice === undefined) return null;
  if (input.costPrice == null) {
    return { costPrice: null, costBreakdown: null };
  }
  return costWritePayload([emptyCostLine(Number(input.costPrice))]);
}

export function mapMenuCategoryForClient(
  c: any,
  opts?: { includeCost?: boolean; includeInactiveItems?: boolean },
) {
  const includeCost = opts?.includeCost !== false;
  const includeInactive = opts?.includeInactiveItems !== false;
  const rawItems = Array.isArray(c.items) ? c.items : [];
  const items = includeInactive
    ? rawItems
    : rawItems.filter((i: any) => i?.active !== false);
  return {
    id: c.id,
    name: c.name,
    sortOrder: c.sortOrder,
    active: c.active,
    color: c?.color ?? null,
    kdsStation: c?.kdsStation ?? null,
    items: items.map((i: any) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      price: Number(i.price),
      vatRate: Number(i.vatRate),
      active: i.active,
      categoryId: i.categoryId,
      isKg: menuItemSoldByKg(i),
      station: String(i?.station || 'KITCHEN'),
      stockLevel: normalizeMenuStockLevel(i?.stockLevel),
      stockRemaining:
        i.stockRemaining != null && Number.isFinite(Number(i.stockRemaining))
          ? Number(i.stockRemaining)
          : null,
      ...(includeCost ? menuItemCostDto(i) : {}),
    })),
  };
}

let lastExpireStaleStockAt = 0;
const EXPIRE_STALE_STOCK_EVERY_MS = 60_000;

/** @internal vitest */
export function resetMenuListThrottleForTests(): void {
  lastExpireStaleStockAt = 0;
}

/**
 * Waiter phones poll the menu through SWR. Expiring yesterday's 86s is a
 * write — do it at most once a minute so ten tablets cannot stampede SQLite.
 */
async function expireStaleMenuStockThrottled(): Promise<void> {
  const now = Date.now();
  if (now - lastExpireStaleStockAt < EXPIRE_STALE_STOCK_EVERY_MS) return;
  lastExpireStaleStockAt = now;
  await expireStaleMenuStock(prisma);
}

export async function listMenuCategoriesForClient(opts?: {
  includeCost?: boolean;
  includeInactiveItems?: boolean;
}) {
  await expireStaleMenuStockThrottled();
  const includeInactive = opts?.includeInactiveItems !== false;
  const cats = await prisma.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    include: {
      items: {
        ...(includeInactive ? {} : { where: { active: true } }),
        orderBy: { name: 'asc' },
      },
    },
  });
  return cats.map((c: any) => mapMenuCategoryForClient(c, opts));
}

function slugifySku(name: string): string {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'ITEM';
}

async function nextAvailableSku(preferred: string): Promise<string> {
  const base = slugifySku(preferred);
  for (let i = 0; i < 200; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await prisma.menuItem.findUnique({
      where: { sku: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

export async function createMenuItemFromInput(payload: unknown) {
  const input = CreateMenuItemInputSchema.parse(payload);
  const category = await prisma.category.findUnique({
    where: { id: Number(input.categoryId) },
    select: { kdsStation: true },
  });
  const inheritedStation =
    (category as any)?.kdsStation ??
    (typeof (input as any).station === 'string'
      ? String((input as any).station).toUpperCase()
      : 'KITCHEN');
  const data = {
    name: input.name.trim(),
    categoryId: Number(input.categoryId),
    price: Number(input.price),
    vatRate: Number(
      (input as any).vatRate ?? process.env.VAT_RATE_DEFAULT ?? 0.2,
    ),
    active: (input as any).active ?? true,
    isKg: (input as any).isKg ?? false,
    station: inheritedStation,
    ...(typeof input.stockLevel === 'string'
      ? { stockLevel: normalizeMenuStockLevel(input.stockLevel) }
      : {}),
    ...(input.stockRemaining !== undefined
      ? { stockRemaining: input.stockRemaining }
      : {}),
    ...(menuItemCostWrite(input) ?? {}),
  };
  const explicitSku = normalizeProductCode(String(input.sku || ''));
  if (explicitSku) {
    const clash = await prisma.menuItem.findUnique({
      where: { sku: explicitSku },
      select: { id: true },
    });
    if (clash) {
      throw new Error('This barcode is already used by another product.');
    }
    const created = await prisma.menuItem.create({
      data: { ...data, sku: explicitSku } as any,
    });
    return { id: created.id, sku: created.sku };
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const sku = await nextAvailableSku(String(input.name).trim());
    try {
      const created = await prisma.menuItem.create({
        data: { ...data, sku } as any,
      });
      return { id: created.id, sku: created.sku };
    } catch (e: any) {
      if (e?.code === 'P2002') {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error('Failed to create menu item');
}

export async function updateMenuItemFromInput(payload: unknown) {
  const input = UpdateMenuItemInputSchema.parse(payload);
  await expireStaleMenuStock(prisma);

  const existing = await prisma.menuItem.findUnique({
    where: { id: input.id },
  });
  if (!existing) throw new Error('Menu item not found');

  const today = localCalendarDateKey();
  const curLevel = normalizeMenuStockLevel((existing as any)?.stockLevel);

  const data: Record<string, unknown> = {
    ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
    ...(typeof input.price === 'number' ? { price: input.price } : {}),
    ...(typeof (input as any).vatRate === 'number'
      ? { vatRate: (input as any).vatRate }
      : {}),
    ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
    ...(typeof (input as any).isKg === 'boolean'
      ? { isKg: (input as any).isKg }
      : {}),
    ...(typeof input.categoryId === 'number'
      ? { categoryId: input.categoryId }
      : {}),
    ...(typeof (input as any).station === 'string'
      ? { station: String((input as any).station).toUpperCase() }
      : {}),
    ...(menuItemCostWrite(input) ?? {}),
  };

  if (typeof input.sku === 'string') {
    const nextSku = normalizeProductCode(input.sku);
    if (nextSku && nextSku !== String(existing.sku || '')) {
      const clash = await prisma.menuItem.findUnique({
        where: { sku: nextSku },
        select: { id: true },
      });
      if (clash && clash.id !== existing.id) {
        throw new Error('This barcode is already used by another product.');
      }
      data.sku = nextSku;
    }
  }

  const stockRemainingIn = (input as any).stockRemaining as
    | number
    | null
    | undefined;
  const stockLevelIn =
    typeof input.stockLevel === 'string'
      ? normalizeMenuStockLevel(input.stockLevel)
      : undefined;

  const onHandInventory = storePlanBlocksTables();
  const touchesQtyOnly =
    stockLevelIn === undefined && stockRemainingIn !== undefined;
  const restaurantQtyOnly = touchesQtyOnly && curLevel === 'LOW';

  if (onHandInventory && (stockLevelIn !== undefined || touchesQtyOnly)) {
    Object.assign(
      data,
      applyOnHandStockPatch({
        stockLevelIn,
        stockRemainingIn,
        existingRemaining:
          existing.stockRemaining != null &&
          Number.isFinite(Number(existing.stockRemaining))
            ? Number(existing.stockRemaining)
            : null,
      }),
    );
  } else if (stockLevelIn !== undefined || restaurantQtyOnly) {
    const nextLevel = stockLevelIn ?? curLevel;
    Object.assign(
      data,
      applyDailyStockPatch({
        nextLevel,
        stockRemainingIn,
        existingRemaining: existing.stockRemaining,
        today,
      }),
    );
  }

  await prisma.menuItem.update({
    where: { id: input.id },
    data: data as any,
  });
  return true;
}
