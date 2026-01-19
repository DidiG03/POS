import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const tablesRouter = Router();

const SetOpenSchema = z.object({
  area: z.string().min(1),
  label: z.string().min(1),
  open: z.boolean(),
});

// Store open tables per business in SyncState (same approach as local Electron)
tablesRouter.post('/open', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = SetOpenSchema.parse(req.body || {});
  const key = 'tables:open';
  const keyAt = 'tables:openAt';
  const row = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key } }).catch(() => null);
  const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
  const k = `${input.area}:${input.label}`;
  const wasOpen = Boolean(map[k]);
  if (input.open) map[k] = true;
  else delete map[k];
  await prisma.syncState.upsert({
    where: { businessId_key: { businessId: auth.businessId, key } },
    create: { businessId: auth.businessId, key, valueJson: map },
    update: { valueJson: map },
  });

  // Track open timestamp for current session (used for table tooltips)
  const atRow = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: keyAt } }).catch(() => null);
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  // IMPORTANT: do NOT reset openAt on repeated "open=true" calls.
  // Only set openAt when transitioning from closed -> open (or if it's missing).
  if (input.open) {
    if (!wasOpen || !atMap[k]) atMap[k] = new Date().toISOString();
  }
  else delete atMap[k];
  await prisma.syncState.upsert({
    where: { businessId_key: { businessId: auth.businessId, key: keyAt } },
    create: { businessId: auth.businessId, key: keyAt, valueJson: atMap },
    update: { valueJson: atMap },
  });

  return res.status(200).json(true);
});

tablesRouter.get('/open', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const key = 'tables:open';
  const row = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key } }).catch(() => null);
  const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
  const list = Object.entries(map)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => {
      const [area, label] = k.split(':');
      return { area, label };
    });
  return res.status(200).json(list);
});

