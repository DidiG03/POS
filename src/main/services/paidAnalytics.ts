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
import { sumTicketLinesNetVat } from '@shared/ticketRevenue';
import { isTransferredOutNote } from './tableTransfer';

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
  return {
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
  const { net, vat } = sumTicketLinesNetVat(
    sale.items,
    true,
    Number(opts.defaultVatRate || 0),
  );
  const goods = roundMoney(net + vat);
  // Keep the settled receipt total (service / discount). Only fall back to
  // goods when the ledger row never stored a total.
  const total = sale.total > 0 ? roundMoney(sale.total) : goods;
  return {
    ...sale,
    subtotal: roundMoney(net),
    vatAmount: roundMoney(vat),
    total,
  };
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
  const rows = await prisma.order
    .findMany({
      where: {
        status: 'PAID' as any,
        closedAt: { gte: safe.from, lte: safe.to },
        ...(args.userId ? { userId: args.userId } : {}),
      } as any,
      orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' }, take: 1 },
      },
    })
    .catch(() => []);
  return keepCanonicalPaidOrders(rows as any[])
    .map(paidSaleFromOrderRow)
    .map((sale) => normalizePaidSaleVat(sale, { vatEnabled, defaultVatRate }));
}

export async function countVoidedTickets(
  from: Date,
  to: Date,
): Promise<number> {
  const safe = safeFetchRange(from, to);
  const range = { gte: safe.from, lte: safe.to };
  const keyedHeads = await prisma.ticketLog
    .findMany({
      where: {
        createdAt: range,
        NOT: { OR: [{ sessionKey: null }, { sessionKey: '' }] },
      },
      select: {
        id: true,
        sessionKey: true,
        note: true,
        area: true,
        tableLabel: true,
        createdAt: true,
      },
    })
    .catch(() => []);
  const unkeyed = await prisma.ticketLog
    .findMany({
      where: {
        createdAt: range,
        OR: [{ sessionKey: null }, { sessionKey: '' }],
      },
      select: {
        id: true,
        sessionKey: true,
        note: true,
        area: true,
        tableLabel: true,
        createdAt: true,
        itemsJson: true,
      } as any,
    })
    .catch(() => []);
  const latest = latestRowPerSession(
    [...(keyedHeads as any[]), ...(unkeyed as any[])].filter(
      (r) => !isTransferredOutNote(r?.note),
    ),
  );
  const ids = latest
    .map((r) => Number(r.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return 0;
  const bodies = await prisma.ticketLog
    .findMany({
      where: { id: { in: ids } },
      select: { itemsJson: true },
    })
    .catch(() => []);
  let n = 0;
  for (const r of bodies as any[]) {
    const items = Array.isArray(r.itemsJson) ? r.itemsJson : [];
    if (items.length > 0 && items.every((it: any) => it?.voided === true))
      n += 1;
  }
  return n;
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
  for (const sale of sales) {
    const when = sale.closedAt;
    if (when.getTime() < s.getTime() || when.getTime() > e.getTime()) continue;

    const rowGross = sale.total;
    const rowItems = sale.items.reduce((n, it) => n + num(it.qty), 0);
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

    hourly[when.getHours()].orders += 1;
    hourly[when.getHours()].revenue += rowGross;
    weekday[when.getDay()].orders += 1;
    weekday[when.getDay()].revenue += rowGross;
    const heat = heatmap[reviewHeatmapIndex(when.getDay(), when.getHours())];
    heat.orders += 1;
    heat.revenue += rowGross;

    const bIso = bucketStart(when, granularity).toISOString();
    const idx = seriesIndex.get(bIso);
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
    const start = new Date(today.getTime() - 13 * 86400000);
    for (let i = 0; i < 14; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const from = new Date(d.setHours(0, 0, 0, 0));
      const to = new Date(d.setHours(23, 59, 59, 999));
      const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`;
      buckets.push({ label, from, to });
    }
  } else if (range === 'weekly') {
    const start = new Date(today.getTime() - 7 * 86400000 * 11);
    for (let i = 0; i < 12; i++) {
      const from = new Date(start.getTime() + i * 7 * 86400000);
      const to = new Date(from.getTime() + 6 * 86400000);
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
      fetchPaidSales({ from: curStart, to: curEnd }),
      compare
        ? fetchPaidSales({ from: compare.start, to: compare.end })
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
