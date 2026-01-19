import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const layoutRouter = Router();

layoutRouter.get('/get', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const userId = Number(req.query.userId || 0);
  const area = String(req.query.area || '');
  if (!userId || !area) return res.status(400).json({ error: 'invalid' });
  if (auth.role !== 'ADMIN' && auth.userId !== userId) return res.status(403).json({ error: 'forbidden' });
  const key = `layout:${userId}:${area}`;
  const row = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key } }).catch(() => null);
  return res.status(200).json(((row?.valueJson as any)?.nodes ?? null) as any);
});

const SaveSchema = z.object({
  userId: z.number().int().positive(),
  area: z.string().min(1),
  nodes: z.array(z.any()),
});

layoutRouter.post('/save', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = SaveSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.userId) return res.status(403).json({ error: 'forbidden' });
  const key = `layout:${input.userId}:${input.area}`;
  await prisma.syncState.upsert({
    where: { businessId_key: { businessId: auth.businessId, key } },
    create: { businessId: auth.businessId, key, valueJson: { nodes: input.nodes } },
    update: { valueJson: { nodes: input.nodes } },
  });
  return res.status(200).json(true);
});

