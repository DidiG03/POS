export type MenuStockLevel = 'OK' | 'LOW' | 'OUT';

/** Store counted stock: at or below this on-hand qty the item is Low. */
export const STORE_LOW_STOCK_AT = 5;

export type StockConsumeLine = { sku?: string; qty?: number };

export function inventoryLevelFromOnHand(
  onHand: number,
  lowAt = STORE_LOW_STOCK_AT,
): MenuStockLevel {
  const n = Math.floor(Number(onHand));
  if (!Number.isFinite(n) || n <= 0) return 'OUT';
  if (n <= lowAt) return 'LOW';
  return 'OK';
}

export function storeOnHandWrite(onHand: number): {
  stockLevel: MenuStockLevel;
  stockRemaining: number;
  stockDay: null;
} {
  const n = Math.max(0, Math.floor(Number(onHand) || 0));
  return {
    stockLevel: inventoryLevelFromOnHand(n),
    stockRemaining: n,
    stockDay: null,
  };
}

export function stockLinesFromTicketItems(items: unknown): StockConsumeLine[] {
  if (!Array.isArray(items)) return [];
  const out: StockConsumeLine[] = [];
  for (const raw of items) {
    const it = raw as {
      sku?: unknown;
      qty?: unknown;
      voided?: unknown;
    };
    if (it?.voided === true) continue;
    const sku = String(it?.sku || '').trim();
    if (!sku) continue;
    const qty = Number(it?.qty ?? 1);
    out.push({ sku, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 });
  }
  return out;
}

export function consumeUnits(qty: number | undefined): number {
  const raw = Number(qty ?? 1);
  return Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 1;
}

/**
 * Whether one more unit of an item fits in its counted stock. Stock is only
 * taken off at Send, so units already staged on this sale count against it.
 * `null` stock means the item is not counted and never blocks.
 */
export function stockAllowsAnother(
  stockRemaining: number | null | undefined,
  stagedUnits: number,
): boolean {
  if (stockRemaining == null) return true;
  const left = Math.floor(Number(stockRemaining));
  if (!Number.isFinite(left)) return true;
  const staged = Math.max(0, Number(stagedUnits) || 0);
  return staged + 1 <= left;
}
