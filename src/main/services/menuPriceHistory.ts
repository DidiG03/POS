/**
 * Prices a menu item had until recently.
 *
 * A payment is repriced from the menu on the host (see `linePricing.ts`),
 * but a table ordered before an admin changed a price was quoted — and
 * shown on the waiter's bill — the old one. Keeping the superseded prices
 * for a while lets that sitting be charged what it was quoted instead of
 * being flagged as tampering.
 *
 * Best-effort by design: a failure here must never stop a menu edit.
 */

import { prisma } from '@db/client';

export const MENU_PRICE_HISTORY_KEY = 'menu:priceHistory';

/** Longer than any sitting can last (open tables are voided after 12h). */
export const MENU_PRICE_HISTORY_KEEP_MS = 48 * 60 * 60 * 1000;

const MAX_ENTRIES = 2000;

export interface MenuPriceHistoryEntry {
  sku: string;
  price: number;
  vatRate: number;
  /** When this price stopped being the menu price. */
  until: string;
}

interface PricedItem {
  sku?: unknown;
  price?: unknown;
  vatRate?: unknown;
}

function asEntries(raw: unknown): MenuPriceHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MenuPriceHistoryEntry[] = [];
  for (const e of raw) {
    const sku = String((e as any)?.sku || '');
    const price = Number((e as any)?.price);
    const vatRate = Number((e as any)?.vatRate);
    const until = String((e as any)?.until || '');
    if (!sku || !Number.isFinite(price) || !Number.isFinite(vatRate)) continue;
    if (!Number.isFinite(Date.parse(until))) continue;
    out.push({ sku, price, vatRate, until });
  }
  return out;
}

async function readAll(): Promise<MenuPriceHistoryEntry[]> {
  const row = await prisma.syncState.findUnique({
    where: { key: MENU_PRICE_HISTORY_KEY },
  });
  return asEntries(row?.valueJson);
}

/**
 * Remember the price an item had before an edit. No-op when neither the
 * price, the VAT rate nor the code changed.
 */
export async function recordMenuPriceChange(
  before: PricedItem,
  after: PricedItem,
  now: Date = new Date(),
): Promise<void> {
  const sku = String(before?.sku || '');
  const price = Number(before?.price);
  const vatRate = Number(before?.vatRate);
  if (!sku || !Number.isFinite(price) || !Number.isFinite(vatRate)) return;
  const unchanged =
    String(after?.sku ?? sku) === sku &&
    Number(after?.price ?? price) === price &&
    Number(after?.vatRate ?? vatRate) === vatRate;
  if (unchanged) return;

  try {
    const cutoff = now.getTime() - MENU_PRICE_HISTORY_KEEP_MS;
    const kept = (await readAll()).filter((e) => Date.parse(e.until) >= cutoff);
    kept.push({ sku, price, vatRate, until: now.toISOString() });
    const valueJson = kept.slice(-MAX_ENTRIES) as any;
    await prisma.syncState.upsert({
      where: { key: MENU_PRICE_HISTORY_KEY },
      create: { key: MENU_PRICE_HISTORY_KEY, valueJson },
      update: { valueJson },
    });
  } catch (e) {
    console.warn('[menuPriceHistory] could not record a price change', e);
  }
}

/** Prices that were still on the menu at or after `since`. */
export async function readMenuPriceHistorySince(
  since: Date,
): Promise<MenuPriceHistoryEntry[]> {
  const from = since.getTime();
  return (await readAll()).filter((e) => Date.parse(e.until) >= from);
}
