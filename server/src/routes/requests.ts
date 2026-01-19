import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const requestsRouter = Router();

const CancelStaleSchema = z.object({
  area: z.string().min(1),
  tableLabel: z.string().min(1),
  // optional override, defaults to 12 hours
  cutoffHours: z.number().int().min(1).max(72).optional(),
});

// Cancel any pending/approved requests for a table that has been open longer than cutoffHours.
// This prevents late requests from being applied to expired/auto-voided tickets.
requestsRouter.post('/cancel-stale-for-table', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = CancelStaleSchema.parse(req.body || {});
  const cutoffMs = (Number(input.cutoffHours || 12) || 12) * 60 * 60 * 1000;
  const key = `${input.area}:${input.tableLabel}`;

  // Verify the table is actually stale (based on tables:openAt in tenant sync state)
  const atRow = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:openAt' } }).catch(() => null);
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const sinceIso = atMap[key];
  const since = sinceIso ? new Date(sinceIso).getTime() : NaN;
  if (!Number.isFinite(since) || Date.now() - since < cutoffMs) {
    return res.status(200).json({ ok: false, skipped: true });
  }

  const now = new Date();
  const rows = await prisma.ticketRequest.findMany({
    where: { businessId: auth.businessId, area: input.area, tableLabel: input.tableLabel, status: { in: ['PENDING', 'APPROVED'] as any } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  } as any);

  if (!rows.length) return res.status(200).json({ ok: true, cancelled: 0 });

  await prisma.ticketRequest.updateMany({
    where: { businessId: auth.businessId, area: input.area, tableLabel: input.tableLabel, status: { in: ['PENDING', 'APPROVED'] as any } },
    data: { status: 'REJECTED' as any, decidedAt: now },
  } as any);

  const msg = `Auto-cancelled add-item requests on ${input.area} ${input.tableLabel}: ticket exceeded ${Math.round(cutoffMs / 36e5)} hours`;
  // Notify all requesters + owners involved
  const usersToNotify = new Set<number>();
  for (const r of rows as any[]) {
    usersToNotify.add(Number(r.requesterId));
    usersToNotify.add(Number(r.ownerId));
  }
  for (const uid of usersToNotify) {
    if (!uid) continue;
    await prisma.notification.create({ data: { businessId: auth.businessId, userId: uid, type: 'OTHER' as any, message: msg } as any }).catch(() => {});
  }
  // Also notify all admins
  const admins = await prisma.user.findMany({ where: { businessId: auth.businessId, role: 'ADMIN', active: true } as any }).catch(() => []);
  for (const a of admins as any[]) {
    await prisma.notification.create({ data: { businessId: auth.businessId, userId: a.id, type: 'OTHER' as any, message: msg } as any }).catch(() => {});
  }

  return res.status(200).json({ ok: true, cancelled: rows.length });
});

const CreateSchema = z.object({
  requesterId: z.number().int().positive(),
  ownerId: z.number().int().positive(),
  area: z.string().min(1),
  tableLabel: z.string().min(1),
  items: z.array(z.any()),
  note: z.string().nullable().optional(),
});

requestsRouter.post('/create', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = CreateSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.requesterId) return res.status(403).json({ error: 'forbidden' });

  const created = await prisma.ticketRequest.create({
    data: {
      businessId: auth.businessId,
      requesterId: input.requesterId,
      ownerId: input.ownerId,
      area: input.area,
      tableLabel: input.tableLabel,
      itemsJson: input.items as any,
      note: input.note ?? null,
      status: 'PENDING' as any,
    } as any,
  });

  // Notify owner (tenant-scoped)
  const requester = await prisma.user.findFirst({ where: { businessId: auth.businessId, id: input.requesterId } });
  const msg = `${requester?.displayName || 'Staff'} requested to add items on ${input.area} ${input.tableLabel} (Request #${created.id})`;
  await prisma.notification
    .create({ data: { businessId: auth.businessId, userId: input.ownerId, type: 'OTHER' as any, message: msg } as any })
    .catch(() => {});

  return res.status(200).json(true);
});

requestsRouter.get('/list-for-owner', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const ownerId = Number(req.query.ownerId || 0);
  if (!ownerId) return res.status(400).json({ error: 'invalid' });
  if (auth.role !== 'ADMIN' && auth.userId !== ownerId) return res.status(403).json({ error: 'forbidden' });

  const rows = await prisma.ticketRequest.findMany({
    where: { businessId: auth.businessId, ownerId, status: 'PENDING' as any },
    orderBy: { createdAt: 'desc' },
  } as any);

  return res.status(200).json(rows.map((r: any) => ({ id: r.id, area: r.area, tableLabel: r.tableLabel, requesterId: r.requesterId, items: r.itemsJson, note: r.note, createdAt: r.createdAt.toISOString() })));
});

const DecideSchema = z.object({ id: z.number().int().positive(), ownerId: z.number().int().positive() });

requestsRouter.post('/approve', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = DecideSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.ownerId) return res.status(403).json({ error: 'forbidden' });

  const r = await prisma.ticketRequest.findFirst({ where: { businessId: auth.businessId, id: input.id } });
  if (!r || r.ownerId !== input.ownerId || r.status !== ('PENDING' as any)) return res.status(200).json(false);

  await prisma.ticketRequest.update({ where: { id: r.id }, data: { status: 'APPROVED' as any, decidedAt: new Date() } });
  await prisma.notification
    .create({ data: { businessId: auth.businessId, userId: r.requesterId, type: 'OTHER' as any, message: `Your request #${r.id} on ${r.area} ${r.tableLabel} was approved` } as any })
    .catch(() => {});
  return res.status(200).json(true);
});

requestsRouter.post('/reject', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = DecideSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.ownerId) return res.status(403).json({ error: 'forbidden' });

  const r = await prisma.ticketRequest.findFirst({ where: { businessId: auth.businessId, id: input.id } });
  if (!r || r.ownerId !== input.ownerId || r.status !== ('PENDING' as any)) return res.status(200).json(false);

  await prisma.ticketRequest.update({ where: { id: r.id }, data: { status: 'REJECTED' as any, decidedAt: new Date() } });
  await prisma.notification
    .create({ data: { businessId: auth.businessId, userId: r.requesterId, type: 'OTHER' as any, message: `Your request #${r.id} on ${r.area} ${r.tableLabel} was rejected` } as any })
    .catch(() => {});
  return res.status(200).json(true);
});

requestsRouter.get('/poll-approved', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const ownerId = Number(req.query.ownerId || 0);
  const area = String(req.query.area || '');
  const tableLabel = String(req.query.tableLabel || '');
  if (!ownerId || !area || !tableLabel) return res.status(400).json({ error: 'invalid' });
  if (auth.role !== 'ADMIN' && auth.userId !== ownerId) return res.status(403).json({ error: 'forbidden' });

  const rows = await prisma.ticketRequest.findMany({
    where: { businessId: auth.businessId, ownerId, area, tableLabel, status: 'APPROVED' as any },
    orderBy: { createdAt: 'asc' },
  } as any);
  return res.status(200).json(rows.map((r: any) => ({ id: r.id, items: r.itemsJson, note: r.note })));
});

const MarkAppliedSchema = z.object({ ids: z.array(z.number().int().positive()).min(1) });

requestsRouter.post('/mark-applied', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = MarkAppliedSchema.parse(req.body || {});
  await prisma.ticketRequest.updateMany({
    where: { businessId: auth.businessId, id: { in: input.ids }, status: 'APPROVED' as any },
    data: { status: 'APPLIED' as any, decidedAt: new Date() },
  } as any);
  return res.status(200).json(true);
});

