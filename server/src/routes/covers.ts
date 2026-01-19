import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const coversRouter = Router();

const SaveSchema = z.object({
  area: z.string().min(1),
  label: z.string().min(1),
  covers: z.number().int().positive(),
});

coversRouter.post('/save', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = SaveSchema.parse(req.body || {});
  await prisma.covers.create({
    data: {
      businessId: auth.businessId,
      area: input.area,
      label: input.label,
      covers: input.covers,
    },
  });
  return res.status(200).json(true);
});

coversRouter.get('/last', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const area = String(req.query.area || '');
  const label = String(req.query.label || '');
  if (!area || !label) return res.status(400).json({ error: 'invalid' });
  const row = await prisma.covers.findFirst({
    where: { businessId: auth.businessId, area, label },
    orderBy: { id: 'desc' },
  });
  return res.status(200).json(row?.covers ?? null);
});

