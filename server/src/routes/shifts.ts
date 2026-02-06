import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';
import bcrypt from 'bcryptjs';

export const shiftsRouter = Router();

// Public "who is clocked in" endpoint for the login screen (no token required).
// This prevents false "clocked out" UI when the POS app has no valid token yet (fresh boot / expired session).
shiftsRouter.get('/public-open', async (req, res) => {
  const businessCode = String(req.query.businessCode || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  if (!businessCode || businessCode.length < 2) return res.status(400).json({ error: 'businessCode required' });
  const biz = await prisma.business.findUnique({ where: { code: businessCode } }).catch(() => null);
  if (!biz || (biz as any).active === false) return res.status(200).json([]);

  // If tenant has an access password, require it (prevents enumeration by code alone).
  const hash = String((biz as any).accessPasswordHash || '').trim();
  if (hash) {
    const supplied = String(req.header('x-business-password') || '').trim();
    if (!supplied) return res.status(200).json([]);
    const ok = await bcrypt.compare(supplied, hash).catch(() => false);
    if (!ok) return res.status(200).json([]);
  }
  const rows = await prisma.dayShift.findMany({ where: { businessId: (biz as any).id, closedAt: null } }).catch(() => []);
  return res.status(200).json(rows.map((s: any) => s.openedById));
});

shiftsRouter.get('/open', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const rows = await prisma.dayShift.findMany({ where: { businessId: auth.businessId, closedAt: null } });
  return res.status(200).json(rows.map((s) => s.openedById));
});

shiftsRouter.get('/get-open', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const userId = Number(req.query.userId || 0);
  if (!userId) return res.status(400).json({ error: 'invalid userId' });
  if (auth.role !== 'ADMIN' && auth.userId !== userId) return res.status(403).json({ error: 'forbidden' });
  const open = await prisma.dayShift.findFirst({ where: { businessId: auth.businessId, closedAt: null, openedById: userId } });
  if (!open) return res.status(200).json(null);
  return res.status(200).json({
    id: open.id,
    openedAt: open.openedAt.toISOString(),
    closedAt: open.closedAt ? open.closedAt.toISOString() : null,
    openedById: open.openedById,
    closedById: open.closedById ?? null,
  });
});

const ClockSchema = z.object({ userId: z.number().int().positive() });

shiftsRouter.post('/clock-in', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = ClockSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.userId) return res.status(403).json({ error: 'forbidden' });

  const already = await prisma.dayShift.findFirst({ where: { businessId: auth.businessId, closedAt: null, openedById: input.userId } });
  if (already) {
    return res.status(200).json({
      id: already.id,
      openedAt: already.openedAt.toISOString(),
      closedAt: already.closedAt ? already.closedAt.toISOString() : null,
      openedById: already.openedById,
      closedById: already.closedById ?? null,
    });
  }
  const created = await prisma.dayShift.create({ data: { businessId: auth.businessId, openedById: input.userId, totalsJson: {} } as any });
  return res.status(200).json({
    id: created.id,
    openedAt: created.openedAt.toISOString(),
    closedAt: null,
    openedById: created.openedById,
    closedById: created.closedById ?? null,
  });
});

shiftsRouter.post('/clock-out', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = ClockSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.userId) return res.status(403).json({ error: 'forbidden' });

  const open = await prisma.dayShift.findFirst({ where: { businessId: auth.businessId, closedAt: null, openedById: input.userId } });
  if (!open) return res.status(200).json(null);
  const updated = await prisma.dayShift.update({ where: { id: open.id }, data: { closedAt: new Date(), closedById: input.userId } });
  return res.status(200).json({
    id: updated.id,
    openedAt: updated.openedAt.toISOString(),
    closedAt: updated.closedAt ? updated.closedAt.toISOString() : null,
    openedById: updated.openedById,
    closedById: updated.closedById ?? null,
  });
});

