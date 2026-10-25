/**
 * Analytics over settled sales (Order / OrderItem / Payment).
 * Kitchen TicketLog is only used for void counts.
 */

import { prisma } from '@db/client';
import type {
  ReviewDTO,
  ReviewGranularity,
  ReviewRangeInput,
} from '@shared/ipc';
import { latestRowPerSession } from '@shared/ticketRevenue';
import { emptyReviewHeatmap, reviewHeatmapIndex } from '@shared/reviewHeatmap';
import { buildTicketSizeBuckets, spendPerCover } from '@shared/reviewMix';
import { normalizePaymentMethod } from '@shared/salesLedger';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import { keepCanonicalPaidOrders } from '@shared/paidSaleDedupe';
import { coreServices } from './core';
import { roundMoney } from '@shared/pricing';
import {
  splitChargedNetVat,
  sumTicketLinesNetVat,
} from '@shared/ticketRevenue';
import {
  isTransferredOutNote,
  TRANSFERRED_OUT_TAG_PREFIX,
} from './tableTransfer';
import { adapterDateTimeText } from '@db/datetimeText';
import { matchOrdersToTicketRows, SITTING_LOOKBACK_MS } from './adminTickets';

export type PaidSaleLine = {
  name: string;
  qty: number;
  unitPrice: number;
  categoryName: string;
};

export type PaidSale = {
  closedAt: Date;
  userId: number | null;
  area: string;
  tableLabel: string;
  covers: number | null;
  subtotal: number;
  vatAmount: number;
  total: number;
  paymentMethod: 'CASH' | 'CARD' | 'MIXED';
  /** False for a partial seat payment; covers count on the closing pay. */
  closeTable: boolean;
  items: PaidSaleLine[];
  /** Ledger row, so a sale can be traced to the sitting it settled. */
  orderId?: number;
};

export type TrendBucket = { label: string; from: Date; to: Date };

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export function safeFetchRange(
  s: Date,
  e: Date,
): { from: Date; to: Date; capped: boolean } {
  const span = e.getTime() - s.getTime();
  if (span <= TWO_YEARS_MS) return { from: s, to: e, capped: false };
  return { from: new Date(e.getTime() - TWO_YEARS_MS), to: e, capped: true };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function saleClosesTable(meta: unknown): boolean {
  const m = (meta || {}) as { closeTable?: boolean };
  return m.closeTable !== false;
}

export function paidSaleFromOrderRow(row: any): PaidSale {
  const meta = row?.payments?.[0]?.metaJson ?? {};
  // A line struck off by a corrective invoice is no longer part of the sale:
  // the order's totals were restated without it, so counting it in
  // top-sellers would credit a dish the guest was refunded for.
  const items = (Array.isArray(row?.items) ? row.items : []).filter(
    (it: any) => it?.voidedAt == null,
  );
  const closedAt = row?.closedAt ? new Date(row.closedAt) : new Date();
  const orderId = Number(row?.id);
  return {
    ...(Number.isInteger(orderId) && orderId > 0 ? { orderId } : {}),
    closedAt,
    userId: Number(row?.userId) > 0 ? Number(row.userId) : null,
    area: String(row?.area || ''),
    tableLabel: String(row?.tableLabel || ''),
    covers: Number(row?.covers) > 0 ? Math.floor(Number(row.covers)) : null,
    subtotal: num(row?.subtotal),
    vatAmount: num(row?.vatAmount),
    total: num(row?.total),
    paymentMethod: normalizePaymentMethod(row?.payments?.[0]?.method),
    closeTable: saleClosesTable(meta),
    items: items.map((it: any) => ({
      name: String(it?.name || 'Item'),
      qty: num(it?.qty),
      unitPrice: num(it?.unitPrice),
      categoryName: String(it?.categoryName || '').trim(),
    })),
  };
}

export function normalizePaidSaleVat(
  sale: PaidSale,
  opts: { vatEnabled: boolean; defaultVatRate?: number },
): PaidSale {
  if (!opts.vatEnabled) {
    const gross = roundMoney(
      sale.total > 0 ? sale.total : sale.subtotal + sale.vatAmount,
    );
    return { ...sale, subtotal: gross, vatAmount: 0, total: gross };
  }
  if (sale.vatAmount > 0) return sale;
  const goodsSplit = sumTicketLinesNetVat(
    sale.items,
    true,
    Number(opts.defaultVatRate || 0),
  );
  const goods = roundMoney(goodsSplit.net + goodsSplit.vat);
  // Keep the settled receipt total (service / discount). Only fall back to
  // goods when the ledger row never stored a total.
  const total = sale.total > 0 ? roundMoney(sale.total) : goods;
  const { net, vat } = splitChargedNetVat(
    sale.items,
    total,
    true,
    Number(opts.defaultVatRate || 0),
  );
  return {
    ...sale,
    subtotal: roundMoney(net),
    vatAmount: roundMoney(vat),
    total,
  };
}

/**
 * `closedAt` range that matches both DateTime storages: INTEGER ms (native
 * engine, plain ledger) and adapter TEXT (encrypted ledger). SQLite sorts
 * every INTEGER before every TEXT, so each half only matches its own kind
 * and both still use the (status, closedAt) index.
 */
function closedAtRangeSql(from: Date, to: Date, column = 'o."closedAt"') {
  return {
    sql:
      `((${column} >= ? AND ${column} <= ?) OR ` +
      `(${column} >= ? AND ${column} <= ?))`,
    args: [
      from.getTime(),
      to.getTime(),
      adapterDateTimeText(from),
      adapterDateTimeText(to),
    ],
  };
}

function sqlDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === 'bigint') return new Date(Number(v));
  return new Date(v as any);
}

/**
 * Paid orders in shape `paidSaleFromOrderRow` reads. Raw SQL, not
 * `findMany` + include: Prisma built a Decimal per money field and a full
 * row per line, so a year of a busy venue took ~12s and ~1.6GB on the
 * till's main process. Only the meta flags the dedupe and covers need are
 * read from `metaJson`.
 */
async function queryPaidOrderRows(
  from: Date,
  to: Date,
  userId?: number,
): Promise<any[]> {
  const range = closedAtRangeSql(from, to);
  const userSql = userId ? ' AND o."userId" = ?' : '';
  const where = `o."status" = 'PAID' AND ${range.sql}${userSql}`;
  const args = [...range.args, ...(userId ? [userId] : [])];
  const orders: any[] = await prisma.$queryRawUnsafe(
    `SELECT o."id", o."userId", o."area", o."tableLabel", o."covers",
       o."closedAt", o."createdAt",
       CAST(o."subtotal" AS REAL) AS "subtotal",
       CAST(o."vatAmount" AS REAL) AS "vatAmount",
       CAST(o."total" AS REAL) AS "total",
       p."method" AS "payMethod",
       p."fiscalNslf" AS "payNslf",
       p."fiscalNivf" AS "payNivf",
       CASE WHEN json_valid(p."metaJson")
         THEN upper(CAST(json_extract(p."metaJson", '$.kind') AS TEXT)) END
         AS "metaKind",
       CASE WHEN json_valid(p."metaJson")
         THEN json_type(p."metaJson", '$.reprint') END AS "metaReprint",
       CASE WHEN json_valid(p."metaJson")
         THEN json_type(p."metaJson", '$.closeTable') END AS "metaCloseTable"
     FROM "Order" o
     LEFT JOIN "Payment" p ON p."id" = (
       SELECT p2."id" FROM "Payment" p2 WHERE p2."orderId" = o."id"
       ORDER BY p2."createdAt" ASC, p2."id" ASC LIMIT 1
     )
     WHERE ${where}
     ORDER BY o."closedAt" ASC, o."id" ASC`,
    ...args,
  );
  if (orders.length === 0) return [];
  const lines: any[] = await prisma.$queryRawUnsafe(
    `SELECT i."orderId", i."name",
       CAST(i."qty" AS REAL) AS "qty",
       CAST(i."unitPrice" AS REAL) AS "unitPrice",
       i."categoryName"
     FROM "OrderItem" i JOIN "Order" o ON o."id" = i."orderId"
     WHERE ${where} AND i."voidedAt" IS NULL
     ORDER BY i."orderId" ASC, i."sortOrder" ASC, i."id" ASC`,
    ...args,
  );
  const itemsByOrder = new Map<number, any[]>();
  for (const l of lines) {
    const id = Number(l.orderId);
    let list = itemsByOrder.get(id);
    if (!list) itemsByOrder.set(id, (list = []));
    list.push(l);
  }
  return orders.map((o) => {
    const id = Number(o.id);
    const meta: Record<string, unknown> = {};
    if (o.metaKind != null) meta.kind = String(o.metaKind);
    if (o.metaReprint === 'true') meta.reprint = true;
    if (o.metaCloseTable === 'false') meta.closeTable = false;
    return {
      id,
      userId: o.userId == null ? null : Number(o.userId),
      area: o.area,
      tableLabel: o.tableLabel,
      covers: o.covers == null ? null : Number(o.covers),
      closedAt: sqlDate(o.closedAt),
      createdAt: sqlDate(o.createdAt),
      subtotal: Number(o.subtotal),
      vatAmount: Number(o.vatAmount),
      total: Number(o.total),
      payments:
        o.payMethod == null
          ? []
          : [
              {
                method: o.payMethod,
                fiscalNslf: o.payNslf,
                fiscalNivf: o.payNivf,
                metaJson: meta,
              },
            ],
      items: itemsByOrder.get(id) ?? [],
    };
  });
}

const FETCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Inclusive, non-overlapping ms windows covering [from, to]. */
export function fetchWindows(from: Date, to: Date): { from: Date; to: Date }[] {
  const out: { from: Date; to: Date }[] = [];
  const end = to.getTime();
  let start = from.getTime();
  if (!(end >= start)) return [{ from, to }];
  while (start <= end) {
    const last = Math.min(end, start + FETCH_WINDOW_MS - 1);
    out.push({ from: new Date(start), to: new Date(last) });
    start = last + 1;
  }
  return out;
}

export async function fetchPaidSales(args: {
  from: Date;
  to: Date;
  userId?: number;
}): Promise<PaidSale[]> {
  const safe = safeFetchRange(args.from, args.to);
  const settings = await coreServices.readSettings().catch(() => ({}));
  const vatEnabled = isVatEnabledFromSettings(settings);
  const defaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  let rows: any[] = [];
  try {
    // Long ranges load in slices with a macrotask between them: one year in
    // a single read held the main thread ~0.5s, stalling waiter requests.
    for (const w of fetchWindows(safe.from, safe.to)) {
      if (rows.length > 0) await new Promise((r) => setImmediate(r));
      rows = rows.concat(await queryPaidOrderRows(w.from, w.to, args.userId));
    }
  } catch {
    rows = [];
  }
  return keepCanonicalPaidOrders(rows)
    .map(paidSaleFromOrderRow)
    .map((sale) => normalizePaidSaleVat(sale, { vatEnabled, defaultVatRate }));
}

const TRIM_WS = "' ' || char(9, 10, 13)";
const SESSION_KEY_SQL = `trim(t."sessionKey", ${TRIM_WS})`;
/** SQL twin of `sessionKeyCanGroup` (NUL never survives into SQLite). */
const SESSION_KEY_GROUPS_SQL =
  `(t."sessionKey" IS NOT NULL AND ${SESSION_KEY_SQL} <> '' AND ` +
  `(instr(t."sessionKey", char(31)) > 0 OR ` +
  `${SESSION_KEY_SQL} <> trim(t."area", ${TRIM_WS})))`;

function createdAtRangeSql(from: Date, to: Date) {
  return closedAtRangeSql(from, to, 't."createdAt"');
}

/**
 * Sittings with a session key whose newest snapshot has every line voided.
 * Counted in SQL: loading a year of TicketLog heads into JS took ~2.7s.
 */
export function voidedKeyedSessionsSql(from: Date, to: Date) {
  const range = createdAtRangeSql(from, to);
  return {
    sql: `WITH heads AS (
       SELECT t."itemsJson" AS items,
         ROW_NUMBER() OVER (
           PARTITION BY ${SESSION_KEY_SQL}
           ORDER BY t."createdAt" DESC, t."id" DESC
         ) AS rn
       FROM "TicketLog" t
       WHERE ${range.sql} AND ${SESSION_KEY_GROUPS_SQL}
         AND instr(coalesce(t."note", ''), ?) = 0
     )
     SELECT count(*) AS n FROM heads
     WHERE rn = 1 AND json_valid(items) AND json_type(items) = 'array'
       AND json_array_length(items) > 0
       AND NOT EXISTS (
         SELECT 1 FROM json_each(heads.items) e
         WHERE (CASE WHEN e.type = 'object'
           THEN json_type(e.value, '$.voided') END) IS NOT 'true'
       )`,
    args: [...range.args, TRANSFERRED_OUT_TAG_PREFIX],
  };
}

/** Rows `latestRowPerSession` groups per table, not per key. */
async function countVoidedLegacyRows(from: Date, to: Date): Promise<number> {
  const range = createdAtRangeSql(from, to);
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT t."id", t."sessionKey", t."note", t."area", t."tableLabel",
       t."createdAt",
       CASE WHEN t."sessionKey" IS NULL OR t."sessionKey" = ''
         THEN t."itemsJson" END AS "itemsJson"
     FROM "TicketLog" t
     WHERE ${range.sql} AND NOT ${SESSION_KEY_GROUPS_SQL}`,
    ...range.args,
  );
  if (rows.length === 0) return 0;
  const latest = latestRowPerSession(
    rows
      .map((r) => ({ ...r, createdAt: sqlDate(r.createdAt) }))
      .filter((r) => !isTransferredOutNote(r?.note)),
  );
  const ids = latest
    .map((r) => Number(r.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return 0;
  const bodies = await prisma.ticketLog.findMany({
    where: { id: { in: ids } },
    select: { itemsJson: true },
  });
  let n = 0;
  for (const r of bodies as any[]) {
    const items = Array.isArray(r.itemsJson) ? r.itemsJson : [];
    if (items.length > 0 && items.every((it: any) => it?.voided === true))
      n += 1;
  }
  return n;
}

export async function countVoidedTickets(
  from: Date,
  to: Date,
): Promise<number> {
  const safe = safeFetchRange(from, to);
  try {
    const keyed = voidedKeyedSessionsSql(safe.from, safe.to);
    const [row]: any[] = await prisma.$queryRawUnsafe(keyed.sql, ...keyed.args);
    return (
      Number(row?.n || 0) + (await countVoidedLegacyRows(safe.from, safe.to))
    );
  } catch {
    return 0;
  }
}

export function bucketLabel(d: Date, g: ReviewGranularity): string {
  if (g === 'year') return String(d.getFullYear());
  if (g === 'month') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function bucketStart(d: Date, g: ReviewGranularity): Date {
  const out = new Date(d);
  if (g === 'year') {
    out.setMonth(0, 1);
    out.setHours(0, 0, 0, 0);
  } else if (g === 'month') {
    out.setDate(1);
    out.setHours(0, 0, 0, 0);
  } else {
    out.setHours(0, 0, 0, 0);
  }
  return out;
}

export function nextBucket(d: Date, g: ReviewGranularity): Date {
  const out = new Date(d);
  if (g === 'year') out.setFullYear(out.getFullYear() + 1);
  else if (g === 'month') out.setMonth(out.getMonth() + 1);
  else out.setDate(out.getDate() + 1);
  return out;
}

export function summarizePaidSales(
  sales: PaidSale[],
  s: Date,
  e: Date,
  granularity: ReviewGranularity,
  voidedTickets: number,
) {
  let revenueNet = 0;
  let revenueVat = 0;
  let revenueGross = 0;
  let items = 0;
  let covers = 0;
  const tables = new Set<string>();
  const waiters = new Set<number>();
  const waiterAgg = new Map<
    number,
    {
      userId: number;
      revenue: number;
      items: number;
      orders: number;
      covers: number;
    }
  >();
  const itemAgg = new Map<
    string,
    { name: string; qty: number; revenue: number }
  >();
  const methodAgg: Record<
    'CASH' | 'CARD' | 'MIXED',
    { orders: number; revenue: number }
  > = {
    CASH: { orders: 0, revenue: 0 },
    CARD: { orders: 0, revenue: 0 },
    MIXED: { orders: 0, revenue: 0 },
  };
  const categoryAgg = new Map<
    string,
    { name: string; qty: number; revenue: number }
  >();
  const areaAgg = new Map<
    string,
    { name: string; orders: number; revenue: number }
  >();
  const ticketTotals: number[] = [];

  const seriesIndex = new Map<string, number>();
  const series: {
    label: string;
    bucketIso: string;
    revenue: number;
    orders: number;
  }[] = [];
  let cursor = bucketStart(s, granularity);
  const cap = nextBucket(bucketStart(e, granularity), granularity);
  let guard = 0;
  while (cursor.getTime() < cap.getTime() && guard < 5000) {
    seriesIndex.set(cursor.toISOString(), series.length);
    series.push({
      label: bucketLabel(cursor, granularity),
      bucketIso: cursor.toISOString(),
      revenue: 0,
      orders: 0,
    });
    cursor = nextBucket(cursor, granularity);
    guard += 1;
  }

  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    orders: 0,
    revenue: 0,
  }));
  const weekday = Array.from({ length: 7 }, (_, d) => ({
    dayOfWeek: d,
    orders: 0,
    revenue: 0,
  }));
  const heatmap = emptyReviewHeatmap();

  let orders = 0;
  let bucketFromMs = NaN;
  let bucketToMs = NaN;
  let bucketIdx: number | undefined;
  for (const sale of sales) {
    const when = sale.closedAt;
    if (when.getTime() < s.getTime() || when.getTime() > e.getTime()) continue;

    const rowGross = sale.total;
    // A weighed portion (0.335 kg) is one item sold, not a third of one.
    const rowItems = sale.items.reduce(
      (n, it) => n + (Number.isInteger(num(it.qty)) ? num(it.qty) : 1),
      0,
    );
    revenueNet += sale.subtotal;
    revenueVat += sale.vatAmount;
    revenueGross += rowGross;
    items += rowItems;
    orders += 1;
    ticketTotals.push(rowGross);

    const method = sale.paymentMethod;
    methodAgg[method].orders += 1;
    methodAgg[method].revenue += rowGross;

    const areaName = String(sale.area || '').trim();
    const area = areaAgg.get(areaName) || {
      name: areaName,
      orders: 0,
      revenue: 0,
    };
    area.orders += 1;
    area.revenue += rowGross;
    areaAgg.set(areaName, area);

    const cov = sale.closeTable ? Number(sale.covers || 0) : 0;
    if (Number.isFinite(cov) && cov > 0) covers += cov;

    tables.add(`${sale.area}|${sale.tableLabel}`);
    const wid = sale.userId;
    if (wid) {
      waiters.add(wid);
      const w = waiterAgg.get(wid) || {
        userId: wid,
        revenue: 0,
        items: 0,
        orders: 0,
        covers: 0,
      };
      w.revenue += rowGross;
      w.items += rowItems;
      w.orders += 1;
      w.covers += Number.isFinite(cov) && cov > 0 ? cov : 0;
      waiterAgg.set(wid, w);
    }

    for (const it of sale.items) {
      const qty = num(it.qty);
      const lineGross = qty * num(it.unitPrice);
      const name = it.name || 'Item';
      const e2 = itemAgg.get(name) || { name, qty: 0, revenue: 0 };
      e2.qty += qty;
      e2.revenue += lineGross;
      itemAgg.set(name, e2);
      const catName = String(it.categoryName || '').trim();
      const cat = categoryAgg.get(catName) || {
        name: catName,
        qty: 0,
        revenue: 0,
      };
      cat.qty += qty;
      cat.revenue += lineGross;
      categoryAgg.set(catName, cat);
    }

    const hour = when.getHours();
    const dow = when.getDay();
    hourly[hour].orders += 1;
    hourly[hour].revenue += rowGross;
    weekday[dow].orders += 1;
    weekday[dow].revenue += rowGross;
    const heat = heatmap[reviewHeatmapIndex(dow, hour)];
    heat.orders += 1;
    heat.revenue += rowGross;

    // Sales arrive in time order, so the bucket rarely changes; a Date and
    // an ISO string per sale was most of a year-long review's main-thread time.
    const at = when.getTime();
    if (!(at >= bucketFromMs && at < bucketToMs)) {
      const start = bucketStart(when, granularity);
      bucketFromMs = start.getTime();
      bucketToMs = nextBucket(start, granularity).getTime();
      bucketIdx = seriesIndex.get(start.toISOString());
    }
    const idx = bucketIdx;
    if (idx != null) {
      series[idx].revenue += rowGross;
      series[idx].orders += 1;
    }
  }

  return {
    summary: {
      startIso: s.toISOString(),
      endIso: e.toISOString(),
      revenueGross: roundMoney(revenueGross),
      revenueNet: roundMoney(revenueNet),
      revenueVat: roundMoney(revenueVat),
      orders,
      items,
      covers,
      avgTicket: orders > 0 ? roundMoney(revenueGross / orders) : 0,
      avgItemsPerTicket: orders > 0 ? items / orders : 0,
      avgSpendPerCover: roundMoney(spendPerCover(revenueGross, covers)),
      uniqueTables: tables.size,
      uniqueWaiters: waiters.size,
      voidedTickets,
    },
    series,
    waiterAgg,
    itemAgg,
    hourly,
    weekday,
    heatmap,
    byMethod: (['CASH', 'CARD', 'MIXED'] as const).map((method) => ({
      method,
      orders: methodAgg[method].orders,
      revenue: roundMoney(methodAgg[method].revenue),
    })),
    byCategory: Array.from(categoryAgg.values())
      .map((c) => ({
        name: c.name,
        qty: c.qty,
        revenue: roundMoney(c.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue),
    byArea: Array.from(areaAgg.values())
      .map((a) => ({
        name: a.name,
        orders: a.orders,
        revenue: roundMoney(a.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue),
    ticketSizes: buildTicketSizeBuckets(ticketTotals).map((b) => ({
      min: b.min,
      max: b.max,
      orders: b.orders,
      revenue: roundMoney(b.revenue),
    })),
  };
}

export function topSellingFromSales(
  sales: PaidSale[],
): { name: string; qty: number; revenue: number } | null {
  const map = new Map<string, { qty: number; revenue: number }>();
  for (const sale of sales) {
    for (const it of sale.items) {
      const name = it.name || 'Item';
      const qty = num(it.qty);
      const revenue = qty * num(it.unitPrice);
      const entry = map.get(name) || { qty: 0, revenue: 0 };
      entry.qty += qty;
      entry.revenue += revenue;
      map.set(name, entry);
    }
  }
  let best: { name: string; qty: number; revenue: number } | null = null;
  for (const [name, v] of map.entries()) {
    if (!best || v.qty > best.qty)
      best = { name, qty: v.qty, revenue: v.revenue };
  }
  return best;
}

export function fillTrendPoints(
  sales: PaidSale[],
  buckets: TrendBucket[],
): { label: string; total: number; orders: number }[] {
  const result = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
  for (const sale of sales) {
    const when = sale.closedAt;
    const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
    if (idx === -1) continue;
    result[idx].total += sale.total;
    result[idx].orders += 1;
  }
  return result;
}

export function sumPaidRevenue(
  sales: PaidSale[],
  opts?: { vatEnabled?: boolean },
): {
  revenueNet: number;
  revenueVat: number;
  revenueGross: number;
} {
  let revenueNet = 0;
  let revenueVat = 0;
  let revenueGross = 0;
  for (const sale of sales) {
    revenueNet += sale.subtotal;
    revenueVat += sale.vatAmount;
    revenueGross += sale.total;
  }
  const gross = roundMoney(revenueGross);
  // When fiskalizimi/VAT is off, headline revenue matches ticket totals (gross).
  if (opts?.vatEnabled === false) {
    return { revenueNet: gross, revenueVat: 0, revenueGross: gross };
  }
  return {
    revenueNet: roundMoney(revenueNet),
    revenueVat: roundMoney(revenueVat),
    revenueGross: gross,
  };
}

export function buildSalesTrendBuckets(
  range: 'daily' | 'weekly' | 'monthly',
): TrendBucket[] {
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const buckets: TrendBucket[] = [];
  if (range === 'daily') {
    // Calendar days, not 86400000 ms: across the spring clock change that
    // started the chart a day early and skipped the change day.
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - 13 + i);
      const from = new Date(d.setHours(0, 0, 0, 0));
      const to = new Date(d.setHours(23, 59, 59, 999));
      const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`;
      buckets.push({ label, from, to });
    }
  } else if (range === 'weekly') {
    for (let i = 0; i < 12; i++) {
      const from = new Date(today);
      from.setDate(today.getDate() - 7 * 11 + i * 7);
      const to = new Date(from);
      to.setDate(from.getDate() + 6);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      const oneJan = new Date(from.getFullYear(), 0, 1);
      const week = Math.ceil(
        ((from.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) /
          7,
      );
      const label = `${from.getFullYear()}-W${String(week).padStart(2, '0')}`;
      buckets.push({ label, from, to });
    }
  } else {
    const startYear = today.getFullYear();
    let m = today.getMonth() - 11;
    for (let i = 0; i < 12; i++, m++) {
      const year = startYear + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12;
      const from = new Date(year, month, 1, 0, 0, 0, 0);
      const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
      const label = `${year}-${String(month + 1).padStart(2, '0')}`;
      buckets.push({ label, from, to });
    }
  }
  return buckets;
}

function parseRange(s?: string | null, e?: string | null) {
  if (!s || !e) return null;
  const start = new Date(s);
  const end = new Date(e);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }
  if (start.getTime() > end.getTime()) return null;
  return { start, end };
}

function todayRange(): { start: Date; end: Date } {
  const s = new Date();
  s.setHours(0, 0, 0, 0);
  const e = new Date();
  e.setHours(23, 59, 59, 999);
  return { start: s, end: e };
}

type SittingLedger = {
  sittings: Array<{
    id: number;
    userId: number;
    area: string;
    tableLabel: string;
    createdAt: Date;
  }>;
  /** Voided sales in range, and every sale in the lookback before it: each
   *  settled a sitting that a later sale must not take. */
  voids: Array<{
    id: number;
    area: string;
    tableLabel: string;
    closedAt: Date;
  }>;
};

/**
 * Table sittings and voided sales in range, read lean for matching sales to
 * the waiter who served them. Same sittings as the staff lists: newest
 * snapshot per session, moved-out rows left out; legacy rows without a
 * usable key are grouped per table in JS as there.
 */
async function loadSittingLedger(from: Date, to: Date): Promise<SittingLedger> {
  // A table served before midnight is paid after it: look back for its sitting.
  const lookback = new Date(from.getTime() - SITTING_LOOKBACK_MS);
  const range = createdAtRangeSql(lookback, to);
  const notMoved = `instr(coalesce(t."note", ''), ?) = 0`;
  const keyed: any[] = await prisma.$queryRawUnsafe(
    `SELECT "id", "userId", "area", "tableLabel", "createdAt" FROM (
       SELECT t."id", t."userId", t."area", t."tableLabel", t."createdAt",
         ROW_NUMBER() OVER (
           PARTITION BY ${SESSION_KEY_SQL}
           ORDER BY t."createdAt" DESC, t."id" DESC
         ) AS rn
       FROM "TicketLog" t
       WHERE ${range.sql} AND ${SESSION_KEY_GROUPS_SQL} AND ${notMoved}
     ) WHERE rn = 1`,
    ...range.args,
    TRANSFERRED_OUT_TAG_PREFIX,
  );
  const legacy: any[] = await prisma.$queryRawUnsafe(
    `SELECT t."id", t."userId", t."area", t."tableLabel", t."createdAt",
       t."sessionKey", CAST(t."itemsJson" AS TEXT) AS "itemsJson"
     FROM "TicketLog" t
     WHERE ${range.sql} AND NOT ${SESSION_KEY_GROUPS_SQL} AND ${notMoved}`,
    ...range.args,
    TRANSFERRED_OUT_TAG_PREFIX,
  );
  const sittings = [
    ...keyed,
    ...latestRowPerSession(
      legacy
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((r) => ({ ...r, createdAt: sqlDate(r.createdAt) })),
    ),
  ].map((r) => ({
    id: Number(r.id),
    userId: Number(r.userId),
    area: String(r.area || ''),
    tableLabel: String(r.tableLabel || ''),
    createdAt: sqlDate(r.createdAt),
  }));
  const closed = closedAtRangeSql(from, to);
  const before = closedAtRangeSql(lookback, new Date(from.getTime() - 1));
  const voids: any[] = await prisma.$queryRawUnsafe(
    `SELECT o."id", o."area", o."tableLabel", o."closedAt" FROM "Order" o
     WHERE (o."status" = 'VOID' AND ${closed.sql})
        OR (o."status" IN ('PAID', 'VOID') AND ${before.sql})`,
    ...closed.args,
    ...before.args,
  );
  return {
    sittings,
    voids: voids.map((o) => ({
      id: Number(o.id),
      area: String(o.area || ''),
      tableLabel: String(o.tableLabel || ''),
      closedAt: sqlDate(o.closedAt),
    })),
  };
}

/**
 * Credit each sale to the waiter whose table it settled, as the staff lists
 * do. `Order.userId` is whoever was signed in where the payment was taken,
 * so a venue that settles at the till showed the admin with every sale.
 * A sale on no sitting (counter, takeaway) keeps the payer.
 */
export function creditServingWaiters(
  sales: PaidSale[],
  ledger: SittingLedger,
): PaidSale[] {
  if (sales.length === 0 || ledger.sittings.length === 0) return sales;
  const orders = [
    ...sales.flatMap((s) =>
      s.orderId
        ? [
            {
              id: s.orderId,
              area: s.area,
              tableLabel: s.tableLabel,
              closedAt: s.closedAt,
            },
          ]
        : [],
    ),
    ...ledger.voids,
  ];
  const { orderIdByTicketId } = matchOrdersToTicketRows(
    ledger.sittings,
    orders,
  );
  const waiterBySittingId = new Map(
    ledger.sittings.map((r) => [r.id, r.userId] as const),
  );
  const servedBy = new Map<number, number>();
  for (const [sittingId, orderId] of orderIdByTicketId) {
    const uid = waiterBySittingId.get(sittingId);
    if (uid && uid > 0) servedBy.set(orderId, uid);
  }
  return sales.map((s) => {
    const uid = s.orderId ? servedBy.get(s.orderId) : undefined;
    return uid && uid !== s.userId ? { ...s, userId: uid } : s;
  });
}

async function servedSales(
  sales: Promise<PaidSale[]>,
  from: Date,
  to: Date,
): Promise<PaidSale[]> {
  const [list, ledger] = await Promise.all([
    sales,
    loadSittingLedger(from, to).catch(() => null),
  ]);
  return ledger ? creditServingWaiters(list, ledger) : list;
}

/**
 * One waiter's sales in range, credited by the tables they served (as the
 * staff lists and Review do), not by the device that took payment. Reads
 * every waiter's sales for the range, since a table this waiter served may
 * have been settled by a colleague or at the till.
 */
export async function fetchServedSales(args: {
  from: Date;
  to: Date;
  userId: number;
}): Promise<PaidSale[]> {
  const sales = await servedSales(
    fetchPaidSales({ from: args.from, to: args.to }),
    args.from,
    args.to,
  );
  return sales.filter((s) => s.userId === args.userId);
}

const SERVED_BY_TTL_MS = 5_000;
let servedByCache: {
  key: string;
  at: number;
  map: Promise<Map<number, number>>;
} | null = null;

/**
 * Who served each sale settled since the start of today, by order id. The
 * waiter's paid list polls this from every phone on the Reports tab, so a
 * few seconds of reuse keeps the till from redoing it per phone.
 */
export function servingWaiterByOrderToday(): Promise<Map<number, number>> {
  const from = new Date(new Date().setHours(0, 0, 0, 0));
  const key = String(from.getTime());
  const now = Date.now();
  if (servedByCache?.key === key && now - servedByCache.at < SERVED_BY_TTL_MS) {
    return servedByCache.map;
  }
  const map = servedSales(
    fetchPaidSales({ from, to: new Date() }),
    from,
    new Date(),
  )
    .then((sales) => {
      const out = new Map<number, number>();
      for (const s of sales)
        if (s.orderId && s.userId) out.set(s.orderId, s.userId);
      return out;
    })
    .catch(() => new Map<number, number>());
  servedByCache = { key, at: now, map };
  return map;
}

export async function getAdminReview(
  input: ReviewRangeInput | null | undefined,
): Promise<ReviewDTO> {
  const settings = await coreServices.readSettings().catch(() => ({}));
  const fiscalVatEnabled = isVatEnabledFromSettings(settings);
  const granularity: ReviewGranularity =
    input?.granularity === 'month' || input?.granularity === 'year'
      ? input.granularity
      : 'day';

  const current =
    parseRange(input?.currentStartIso, input?.currentEndIso) ?? todayRange();
  const curStart = current.start;
  const curEnd = current.end;
  const compare = parseRange(input?.compareStartIso, input?.compareEndIso);

  const [curSales, cmpSales, curVoids, cmpVoids, allUsers, shifts] =
    await Promise.all([
      servedSales(
        fetchPaidSales({ from: curStart, to: curEnd }),
        curStart,
        curEnd,
      ),
      compare
        ? servedSales(
            fetchPaidSales({ from: compare.start, to: compare.end }),
            compare.start,
            compare.end,
          )
        : Promise.resolve([] as PaidSale[]),
      countVoidedTickets(curStart, curEnd),
      compare
        ? countVoidedTickets(compare.start, compare.end)
        : Promise.resolve(0),
      prisma.user
        .findMany({
          select: { id: true, displayName: true, role: true, active: true },
        })
        .catch(() => []),
      prisma.dayShift
        .findMany({
          where: {
            OR: [
              { closedAt: null, openedAt: { lte: curEnd } },
              {
                openedAt: { lte: curEnd },
                closedAt: { gte: curStart },
              },
            ],
          },
          select: { openedById: true, openedAt: true, closedAt: true },
        })
        .catch(
          () =>
            [] as {
              openedById: number;
              openedAt: Date;
              closedAt: Date | null;
            }[],
        ),
    ]);

  const cur = summarizePaidSales(
    curSales,
    curStart,
    curEnd,
    granularity,
    curVoids,
  );
  const cmp = compare
    ? summarizePaidSales(
        cmpSales,
        compare.start,
        compare.end,
        granularity,
        cmpVoids,
      )
    : null;

  const hoursByUser = new Map<number, number>();
  for (const sh of shifts as any[]) {
    const opened = new Date(sh.openedAt).getTime();
    const closed = sh.closedAt ? new Date(sh.closedAt).getTime() : Date.now();
    const overlapStart = Math.max(opened, curStart.getTime());
    const overlapEnd = Math.min(closed, curEnd.getTime());
    if (overlapEnd <= overlapStart) continue;
    const hrs = (overlapEnd - overlapStart) / 36e5;
    hoursByUser.set(
      Number(sh.openedById),
      (hoursByUser.get(Number(sh.openedById)) || 0) + hrs,
    );
  }

  const userById = new Map<
    number,
    { displayName: string; role: string; active: boolean }
  >();
  for (const u of allUsers as any[]) {
    userById.set(Number(u.id), {
      displayName: String(u.displayName || `#${u.id}`),
      role: String(u.role || ''),
      active: Boolean(u.active),
    });
  }
  for (const id of cur.waiterAgg.keys()) {
    if (!userById.has(id)) {
      userById.set(id, {
        displayName: `User #${id}`,
        role: 'UNKNOWN',
        active: false,
      });
    }
  }

  const waiters = Array.from(cur.waiterAgg.values())
    .map((w) => {
      const meta = userById.get(w.userId)!;
      const hours = hoursByUser.get(w.userId) || 0;
      return {
        userId: w.userId,
        name: meta.displayName,
        role: meta.role,
        active: meta.active,
        orders: w.orders,
        items: w.items,
        revenue: w.revenue,
        covers: w.covers,
        avgTicket: w.orders > 0 ? w.revenue / w.orders : 0,
        hoursWorked: Math.round(hours * 100) / 100,
        revenuePerHour: hours > 0 ? w.revenue / hours : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const topItems = Array.from(cur.itemAgg.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15);

  return {
    granularity,
    fiscalEnabled: fiscalVatEnabled,
    current: cur.summary,
    compare: cmp?.summary ?? null,
    series: {
      current: cur.series,
      compare: cmp?.series ?? null,
    },
    topItems,
    waiters,
    hourly: cur.hourly,
    weekday: cur.weekday,
    heatmap: cur.heatmap,
    byMethod: cur.byMethod,
    byCategory: cur.byCategory,
    byArea: cur.byArea,
    ticketSizes: cur.ticketSizes,
  };
}
