import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const reportsRouter = Router();

const TrendSchema = z.object({
  range: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
});

function sumNet(items: any[]) {
  return (items || []).reduce((s: number, it: any) => s + Number(it?.unitPrice || 0) * Number(it?.qty || 1), 0);
}
function sumVat(items: any[]) {
  return (items || []).reduce((s: number, it: any) => s + Number(it?.unitPrice || 0) * Number(it?.qty || 1) * Number(it?.vatRate || 0), 0);
}

reportsRouter.get('/my/overview', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const userId = auth.userId;
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date();

  const rows = await prisma.ticketLog
    .findMany({
      where: { businessId: auth.businessId, userId, createdAt: { gte: start, lte: end } },
      select: { itemsJson: true },
    })
    .catch(() => []);

  const revenueTodayNet = rows.reduce((s: number, r: any) => s + sumNet(r.itemsJson as any[]), 0);
  const revenueTodayVat = rows.reduce((s: number, r: any) => s + sumVat(r.itemsJson as any[]), 0);

  // Open orders for this waiter: open tables whose latest ticket userId matches
  const openRow = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:open' } }).catch(() => null);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<string, boolean>;
  const openKeys = Object.entries(openMap).filter(([, v]) => Boolean(v)).map(([k]) => k);
  const latestMatches = await Promise.all(
    openKeys.map(async (k) => {
      const [area, label] = k.split(':');
      if (!area || !label) return false;
      const last = await prisma.ticketLog
        .findFirst({ where: { businessId: auth.businessId, area, tableLabel: label }, orderBy: { createdAt: 'desc' } })
        .catch(() => null);
      return Boolean(last && Number(last.userId) === Number(userId));
    }),
  );
  const openOrders = latestMatches.filter(Boolean).length;

  return res.status(200).json({ revenueTodayNet, revenueTodayVat, openOrders });
});

reportsRouter.get('/my/top-selling-today', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const userId = auth.userId;
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date(new Date().setHours(23, 59, 59, 999));
  const rows = await prisma.ticketLog.findMany({
    where: { businessId: auth.businessId, userId, createdAt: { gte: start, lte: end } },
    select: { itemsJson: true },
  });
  const map = new Map<string, { qty: number; revenue: number }>();
  for (const r of rows) {
    const items = (r.itemsJson as any[]) || [];
    for (const it of items) {
      const name = String(it?.name || 'Item');
      const qty = Number(it?.qty || 1);
      const revenue = Number(it?.unitPrice || 0) * qty;
      const entry = map.get(name) || { qty: 0, revenue: 0 };
      entry.qty += qty;
      entry.revenue += revenue;
      map.set(name, entry);
    }
  }
  let best: { name: string; qty: number; revenue: number } | null = null;
  for (const [name, v] of map.entries()) {
    if (!best || v.qty > best.qty) best = { name, qty: v.qty, revenue: v.revenue };
  }
  return res.status(200).json(best);
});

reportsRouter.get('/my/sales-trends', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const userId = auth.userId;
  const { range } = TrendSchema.parse(req.query || {});
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const buckets: { label: string; from: Date; to: Date }[] = [];

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
      const week = Math.ceil((((from.getTime() - oneJan.getTime()) / 86400000) + oneJan.getDay() + 1) / 7);
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

  const rows = await prisma.ticketLog
    .findMany({
      where: {
        businessId: auth.businessId,
        userId,
        createdAt: { gte: buckets[0].from, lte: buckets[buckets.length - 1].to },
      },
      select: { createdAt: true, itemsJson: true },
      orderBy: { createdAt: 'asc' },
    })
    .catch(() => []);

  const points = buckets.map((b) => ({ label: b.label, total: 0, orders: 0 }));
  for (const r of rows as any[]) {
    const when = new Date(r.createdAt);
    const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
    if (idx === -1) continue;
    points[idx].total += sumNet(r.itemsJson as any[]);
    points[idx].orders += 1;
  }

  return res.status(200).json({ range, points });
});

reportsRouter.get('/my/active-tickets', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const userId = auth.userId;

  const [openRow, atRow] = await Promise.all([
    prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:open' } }).catch(() => null),
    prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:openAt' } }).catch(() => null),
  ]);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<string, boolean>;
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const openKeys = Object.entries(openMap).filter(([, v]) => Boolean(v)).map(([k]) => k);

  const results = await Promise.all(openKeys.map(async (k) => {
    const [area, tableLabel] = k.split(':');
    if (!area || !tableLabel) return null;
    const last = await prisma.ticketLog
      .findFirst({ where: { businessId: auth.businessId, area, tableLabel }, orderBy: { createdAt: 'desc' } })
      .catch(() => null);
    if (!last || Number(last.userId) !== Number(userId)) return null;

    const sinceIso = atMap[k];
    const sinceParsed = sinceIso ? new Date(sinceIso) : null;
    const since = sinceParsed && Number.isFinite(sinceParsed.getTime()) ? sinceParsed : null;
    const where: any = { businessId: auth.businessId, area, tableLabel };
    if (since) where.createdAt = { gte: since };

    const [rows, coversRow, u] = await Promise.all([
      prisma.ticketLog.findMany({ where, orderBy: { createdAt: 'asc' } }).catch(() => [] as any[]),
      prisma.covers.findFirst({ where: { businessId: auth.businessId, area, label: tableLabel, ...(since ? { createdAt: { gte: since } as any } : {}) }, orderBy: { id: 'desc' } } as any).catch(() => null),
      prisma.user.findFirst({ where: { businessId: auth.businessId, id: last.userId } }).catch(() => null),
    ]);
    const itemsAll = rows.flatMap((r: any) => (Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : []));
    const items = itemsAll.filter((it: any) => !it?.voided);
    const subtotal = sumNet(items);
    const vat = sumVat(items);
    return {
      kind: 'ACTIVE',
      area,
      tableLabel,
      createdAt: (since ? since.toISOString() : last.createdAt.toISOString()),
      paidAt: null,
      covers: coversRow?.covers ?? (last.covers ?? null),
      note: (rows.find((r: any) => r.note)?.note ?? last.note ?? null),
      userName: u?.displayName ?? null,
      paymentMethod: null,
      items,
      subtotal,
      vat,
      total: subtotal + vat,
    };
  }));

  return res.status(200).json((results.filter(Boolean) as any[]).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
});

reportsRouter.get('/my/paid-tickets', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const userId = auth.userId;
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 40)));

  const jobs = await prisma.printJob.findMany({
    where: { businessId: auth.businessId, type: 'RECEIPT' as any },
    orderBy: { createdAt: 'desc' },
    take: 500,
  } as any).catch(() => []);

  const out: any[] = [];
  for (const j of jobs as any[]) {
    const p = (j.payloadJson as any) || {};
    const meta = (p?.meta as any) || {};
    if (String(meta?.kind || '') !== 'PAYMENT') continue;
    if (Number(meta?.userId || 0) !== Number(userId)) continue;
    const area = String(p.area || '');
    const tableLabel = String(p.tableLabel || '');
    const items = Array.isArray(p.items) ? p.items : [];
    const note = p.note ?? null;
    const covers = p.covers ?? null;
    const userName = p.userName ?? null;
    const paymentMethod = (meta.method ?? null) as any;
    const paidAt = meta.paidAt ?? j.createdAt.toISOString();
    const subtotal = sumNet(items);
    const vatEnabled = meta?.vatEnabled !== false;
    const vat = vatEnabled ? sumVat(items) : 0;
    const serviceChargeEnabled = (meta.serviceChargeEnabled ?? null) as any;
    const serviceChargeApplied = (meta.serviceChargeApplied ?? null) as any;
    const serviceChargeMode = (meta.serviceChargeMode ?? null) as any;
    const serviceChargeValue = (meta.serviceChargeValue ?? null) as any;
    const serviceChargeAmount = Number(meta.serviceChargeAmount || 0);
    const discountType = (meta.discountType ?? null) as any;
    const discountValue = (meta.discountValue ?? null) as any;
    const discountAmount = Number(meta.discountAmount || 0);
    const discountReason = (meta.discountReason ?? null) as any;
    const fallbackTotal = Math.max(
      0,
      subtotal + vat +
        (Number.isFinite(serviceChargeAmount) ? serviceChargeAmount : 0) -
        (Number.isFinite(discountAmount) ? discountAmount : 0),
    );
    const totalAfter = Number(meta.totalAfter);
    const total = Number.isFinite(totalAfter) ? Math.max(0, totalAfter) : fallbackTotal;
    const hay = `${area} ${tableLabel} ${String(userName || '')} ${items.map((it: any) => it.name).join(' ')}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    out.push({
      kind: 'PAID',
      area,
      tableLabel,
      createdAt: j.createdAt.toISOString(),
      paidAt,
      covers,
      note,
      userName,
      paymentMethod,
      vatEnabled,
      serviceChargeEnabled,
      serviceChargeApplied,
      serviceChargeMode,
      serviceChargeValue,
      serviceChargeAmount: Number.isFinite(serviceChargeAmount) ? serviceChargeAmount : null,
      discountType,
      discountValue,
      discountAmount: Number.isFinite(discountAmount) ? discountAmount : null,
      discountReason,
      items,
      subtotal,
      vat,
      total,
    });
    if (out.length >= limit) break;
  }

  return res.status(200).json(out);
});

