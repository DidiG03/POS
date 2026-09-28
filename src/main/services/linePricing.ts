/**
 * Host-side line prices for a payment.
 *
 * `paymentTotals.ts` stopped clients from deciding what a ticket adds up
 * to, but each line still carried the client's own `unitPrice` and
 * `vatRate` — and those are what the receipt, the sales ledger and the
 * fiscal invoice are built from. A phone running a stale bundle, or one
 * that has been tampered with, could send a 500 lek dish at 50 and the
 * tax office would be told 50.
 *
 * Every line is now checked against this host's menu:
 *
 *   - price and VAT match the menu           → unchanged
 *   - they match a price the item had since
 *     the table was seated (admin edited the
 *     menu mid-sitting)                      → unchanged, the table keeps
 *                                              what it was quoted
 *   - anything else                          → the menu's price/VAT, and
 *                                              the correction is reported
 *   - not on the menu at all                 → unchanged, but reported
 *   - quantity zero or negative              → dropped, reported
 *
 * Like the totals check, a divergence never refuses the payment.
 */

import { prisma } from '@db/client';
import { roundMoney } from '@shared/pricing';
import {
  MENU_PRICE_HISTORY_KEEP_MS,
  readMenuPriceHistorySince,
  type MenuPriceHistoryEntry,
} from './menuPriceHistory';
import { getTableSessionStartedAt } from './tableSession';

/** Longest a sitting can run: stale tables are auto-voided after 12h. */
const SITTING_LOOKBACK_MS = 13 * 60 * 60 * 1000;

const PRICE_TOLERANCE = 0.005;
const VAT_TOLERANCE = 0.0005;

export interface MenuPrice {
  sku: string;
  name: string;
  price: number;
  vatRate: number;
}

export interface LinePriceIssue {
  kind: 'repriced' | 'unknown' | 'dropped';
  name: string;
  sku: string;
  claimedPrice: number | null;
  menuPrice?: number;
  claimedVatRate?: number | null;
  menuVatRate?: number;
  qty?: number | null;
}

export interface RepriceResult {
  items: any[];
  issues: LinePriceIssue[];
}

function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) < PRICE_TOLERANCE;
}

function sameVat(a: number, b: number): boolean {
  return Math.abs(a - b) < VAT_TOLERANCE;
}

function finite(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a line to a menu item: by code, then — for tickets logged before
 * lines carried a code, which the till rehydrates with the name as the
 * code — by name when exactly one item has it.
 */
function findMenuItem(
  line: any,
  bySku: Map<string, MenuPrice>,
  byName: Map<string, MenuPrice | null>,
): MenuPrice | null {
  const sku = String(line?.sku || '').trim();
  if (sku && bySku.has(sku)) return bySku.get(sku)!;
  const name = String(line?.name || '').trim();
  const candidates = [sku, name].filter(Boolean);
  for (const key of candidates) {
    const hit = byName.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Pure core: reprice `items` against a menu snapshot plus the prices the
 * menu had since the sitting began.
 */
export function repriceLines(
  items: unknown,
  menu: MenuPrice[],
  history: MenuPriceHistoryEntry[],
): RepriceResult {
  const bySku = new Map<string, MenuPrice>();
  const byName = new Map<string, MenuPrice | null>();
  for (const m of menu) {
    bySku.set(m.sku, m);
    // A name shared by two items is ambiguous; never guess between them.
    byName.set(m.name, byName.has(m.name) ? null : m);
  }
  const pastPrices = new Map<string, MenuPriceHistoryEntry[]>();
  for (const h of history) {
    const list = pastPrices.get(h.sku) ?? [];
    list.push(h);
    pastPrices.set(h.sku, list);
  }

  const out: any[] = [];
  const issues: LinePriceIssue[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    // Money and tax classification come from the menu, never the line.
    const line = { ...((raw ?? {}) as any) };
    delete line.vatCode;
    delete line.vatExempt;
    const name = String(line?.name || '');
    const sku = String(line?.sku || '');
    const claimedPrice = finite(line?.unitPrice);
    const claimedVat = finite(line?.vatRate);

    if (line?.voided === true) {
      out.push(line);
      continue;
    }

    const qty = finite(line?.qty ?? 1);
    if (qty === null || qty <= 0) {
      issues.push({ kind: 'dropped', name, sku, claimedPrice, qty });
      continue;
    }

    const item = findMenuItem(line, bySku, byName);
    if (!item) {
      issues.push({ kind: 'unknown', name, sku, claimedPrice });
      out.push(line);
      continue;
    }

    const past = pastPrices.get(item.sku) ?? [];
    const priceOk =
      claimedPrice !== null &&
      (samePrice(claimedPrice, item.price) ||
        past.some((p) => samePrice(claimedPrice, p.price)));
    const vatOk =
      claimedVat !== null &&
      (sameVat(claimedVat, item.vatRate) ||
        past.some((p) => sameVat(claimedVat, p.vatRate)));

    if (priceOk && vatOk) {
      out.push(line);
      continue;
    }

    out.push({
      ...line,
      unitPrice: priceOk ? claimedPrice : item.price,
      vatRate: vatOk ? claimedVat : item.vatRate,
    });
    issues.push({
      kind: 'repriced',
      name: name || item.name,
      sku: item.sku,
      claimedPrice,
      menuPrice: item.price,
      claimedVatRate: claimedVat,
      menuVatRate: item.vatRate,
    });
  }
  return { items: out, issues };
}

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? '?' : roundMoney(n).toFixed(2);
}

function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? '?' : `${roundMoney(n * 100)}%`;
}

/** One-line summary for the admin alert and the audit row. */
export function describeLineIssues(issues: LinePriceIssue[]): string | null {
  if (!issues.length) return null;
  const parts = issues.map((i) => {
    const label = i.name || i.sku || 'item';
    if (i.kind === 'dropped') {
      return `${label} removed (quantity ${i.qty ?? '?'})`;
    }
    if (i.kind === 'unknown') {
      return `${label} is not on the menu (charged ${money(i.claimedPrice)} as sent)`;
    }
    const changes: string[] = [];
    if (i.claimedPrice === null || !samePrice(i.claimedPrice, i.menuPrice!)) {
      changes.push(`price ${money(i.claimedPrice)} → ${money(i.menuPrice)}`);
    }
    if (
      i.claimedVatRate === null ||
      i.claimedVatRate === undefined ||
      !sameVat(i.claimedVatRate, i.menuVatRate!)
    ) {
      changes.push(`VAT ${pct(i.claimedVatRate)} → ${pct(i.menuVatRate)}`);
    }
    return `${label} ${changes.join(', ')}`;
  });
  return `line prices corrected from the menu: ${parts.join('; ')}`;
}

async function loadMenu(items: unknown): Promise<MenuPrice[]> {
  const keys = new Set<string>();
  for (const line of Array.isArray(items) ? items : []) {
    const sku = String((line as any)?.sku || '').trim();
    const name = String((line as any)?.name || '').trim();
    if (sku) keys.add(sku);
    if (name) keys.add(name);
  }
  if (!keys.size) return [];
  const list = [...keys];
  const rows = await prisma.menuItem.findMany({
    where: { OR: [{ sku: { in: list } }, { name: { in: list } }] },
    select: { sku: true, name: true, price: true, vatRate: true },
  } as any);
  return (rows as any[]).map((r) => ({
    sku: String(r.sku),
    name: String(r.name),
    price: Number(r.price),
    vatRate: Number(r.vatRate),
  }));
}

/**
 * Reprice a payment's lines from this host's menu.
 *
 * Returns `null` when the menu could not be read — the caller then keeps
 * the client's lines and says so, because refusing a paying customer over
 * a database hiccup is worse than one unverified receipt.
 */
export async function repriceLinesFromMenu(input: {
  items: unknown;
  area: string;
  tableLabel: string;
  now?: Date;
}): Promise<RepriceResult | null> {
  const now = input.now ?? new Date();
  try {
    const menu = await loadMenu(input.items);
    const seatedAt = await getTableSessionStartedAt(
      input.area,
      input.tableLabel,
    ).catch(() => null);
    const floor = now.getTime() - MENU_PRICE_HISTORY_KEEP_MS;
    const since = new Date(
      Math.max(
        floor,
        seatedAt ? seatedAt.getTime() : now.getTime() - SITTING_LOOKBACK_MS,
      ),
    );
    const history = await readMenuPriceHistorySince(since).catch(() => []);
    return repriceLines(input.items, menu, history);
  } catch (e) {
    console.error('[linePricing] could not read the menu to check prices', e);
    return null;
  }
}
