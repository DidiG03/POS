import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';
import crypto from 'node:crypto';

export const adminRouter = Router();

function requireAdmin(req: AuthedRequest) {
  const auth = req.auth!;
  if (auth.role !== 'ADMIN') {
    const err: any = new Error('forbidden');
    err.statusCode = 403;
    throw err;
  }
  return auth;
}

adminRouter.get('/business', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  const biz = await prisma.business.findUnique({ where: { id: auth.businessId } });
  if (!biz) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ id: biz.id, name: biz.name, code: biz.code, active: (biz as any).active !== false, createdAt: biz.createdAt.toISOString() });
});

adminRouter.post('/business/rotate-code', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  const current = await prisma.business.findUnique({ where: { id: auth.businessId } });
  if (!current) return res.status(404).json({ error: 'not found' });

  // Generate a short human-friendly code, ensure uniqueness.
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(6).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10);
    const exists = await prisma.business.findUnique({ where: { code } });
    if (exists) continue;
    const updated = await prisma.business.update({ where: { id: auth.businessId }, data: { code } });
    return res.status(200).json({ ok: true, code: updated.code });
  }
  return res.status(500).json({ error: 'failed to generate code' });
});

adminRouter.post('/business/disable', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  await prisma.business.updateMany({ where: { id: auth.businessId }, data: { active: false } as any });
  return res.status(200).json({ ok: true });
});

adminRouter.get('/overview', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);

  const [users, openShifts, menuSync, revenueRows] = await Promise.all([
    prisma.user.count({ where: { businessId: auth.businessId, active: true } }),
    prisma.dayShift.count({ where: { businessId: auth.businessId, closedAt: null } }),
    prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'menu:lastSync' } }).catch(() => null),
    prisma.ticketLog
      .findMany({
        where: {
          businessId: auth.businessId,
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lte: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        },
        select: { itemsJson: true },
      })
      .catch(() => []),
  ]);

  const revenueTodayNet = (revenueRows as any[]).reduce(
    (s, r) => s + (r.itemsJson as any[]).reduce((ss: number, it: any) => ss + Number(it.unitPrice) * Number(it.qty || 1), 0),
    0,
  );
  const revenueTodayVat = (revenueRows as any[]).reduce(
    (s, r) => s + (r.itemsJson as any[]).reduce((ss: number, it: any) => ss + Number(it.unitPrice) * Number(it.qty || 1) * Number(it.vatRate || 0), 0),
    0,
  );

  return res.status(200).json({
    activeUsers: users,
    openShifts,
    openOrders: 0, // cloud mode: table-open state not yet tracked centrally
    lowStockItems: 0,
    queuedPrintJobs: 0,
    lastMenuSync: (menuSync as any)?.updatedAt?.toISOString?.() ?? null,
    lastStaffSync: null,
    printerIp: null,
    appVersion: process.env.npm_package_version || '0.1.0',
    revenueTodayNet,
    revenueTodayVat,
  });
});

adminRouter.get('/shifts', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  const rows = await prisma.dayShift
    .findMany({
      where: { businessId: auth.businessId },
      orderBy: { openedAt: 'desc' },
      include: { openedBy: true, closedBy: true },
    })
    .catch(() => []);
  return res.status(200).json(
    rows.map((r: any) => {
      const end = r.closedAt ? new Date(r.closedAt) : new Date();
      const start = new Date(r.openedAt);
      const durationMs = Math.max(0, end.getTime() - start.getTime());
      const durationHours = Math.round((durationMs / 36e5) * 100) / 100;
      return {
        id: r.id,
        userId: r.openedById,
        userName: r.openedBy?.displayName ?? `#${r.openedById}`,
        openedAt: r.openedAt.toISOString(),
        closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
        durationHours,
        isOpen: !r.closedAt,
      };
    }),
  );
});

adminRouter.get('/top-selling-today', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date(new Date().setHours(23, 59, 59, 999));
  const rows = await prisma.ticketLog.findMany({
    where: { businessId: auth.businessId, createdAt: { gte: start, lte: end } },
    select: { itemsJson: true },
  });
  const map = new Map<string, { qty: number; revenue: number }>();
  for (const r of rows) {
    const items = (r.itemsJson as any[]) || [];
    for (const it of items) {
      const name = String(it.name || 'Item');
      const qty = Number(it.qty || 1);
      const revenue = Number(it.unitPrice || 0) * qty;
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

adminRouter.get('/ticket-counts', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  const startIso = typeof req.query.startIso === 'string' ? req.query.startIso : '';
  const endIso = typeof req.query.endIso === 'string' ? req.query.endIso : '';
  const where: any = { businessId: auth.businessId };
  if (startIso || endIso) {
    where.createdAt = {};
    if (startIso) where.createdAt.gte = new Date(startIso);
    if (endIso) where.createdAt.lte = new Date(endIso);
  }
  const logs = await prisma.ticketLog.groupBy({ where, by: ['userId'], _count: { userId: true } } as any).catch(() => []);
  const users = await prisma.user.findMany({ where: { businessId: auth.businessId, role: { not: 'ADMIN' } } as any });
  const openShifts = await prisma.dayShift.findMany({ where: { businessId: auth.businessId, closedAt: null } });
  const openIds = new Set(openShifts.map((s: any) => s.openedById));
  const counts: Record<number, number> = {};
  for (const r of logs as any[]) counts[r.userId] = r._count.userId;
  return res.status(200).json(users.map((u: any) => ({ id: u.id, name: u.displayName, active: openIds.has(u.id), tickets: counts[u.id] ?? 0 })));
});

adminRouter.get('/tickets-by-user', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  const userId = Number(req.query.userId || 0);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const startIso = typeof req.query.startIso === 'string' ? req.query.startIso : '';
  const endIso = typeof req.query.endIso === 'string' ? req.query.endIso : '';
  const where: any = { businessId: auth.businessId, userId };
  if (startIso || endIso) {
    where.createdAt = {};
    if (startIso) where.createdAt.gte = new Date(startIso);
    if (endIso) where.createdAt.lte = new Date(endIso);
  }
  const rows = await prisma.ticketLog.findMany({ where, orderBy: { createdAt: 'desc' } });
  return res.status(200).json(
    rows.map((r: any) => ({
      id: r.id,
      area: r.area,
      tableLabel: r.tableLabel,
      covers: r.covers,
      createdAt: r.createdAt.toISOString(),
      items: r.itemsJson as any,
      note: r.note,
      subtotal: (r.itemsJson as any[]).reduce((s: number, it: any) => s + Number(it.unitPrice) * Number(it.qty || 1), 0),
      vat: (r.itemsJson as any[]).reduce((s: number, it: any) => s + Number(it.unitPrice) * Number(it.qty || 1) * Number(it.vatRate || 0), 0),
    })),
  );
});

adminRouter.get('/notifications', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  const onlyUnread = String(req.query.onlyUnread || '') === '1';
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const rows = await prisma.notification.findMany({
    where: { businessId: auth.businessId, ...(onlyUnread ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { user: true },
  } as any);
  return res.status(200).json(
    rows.map((n: any) => ({
      id: n.id,
      userId: n.userId,
      userName: n.user?.displayName ?? `#${n.userId}`,
      type: n.type,
      message: n.message,
      readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
      createdAt: new Date(n.createdAt).toISOString(),
    })),
  );
});

adminRouter.post('/notifications/mark-all-read', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  await prisma.notification.updateMany({ where: { businessId: auth.businessId, readAt: null }, data: { readAt: new Date() } });
  return res.status(200).json(true);
});

