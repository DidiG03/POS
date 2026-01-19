import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const notificationsRouter = Router();

// List notifications for the authenticated user (tenant-scoped).
notificationsRouter.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const onlyUnread = String(req.query.onlyUnread || '') === '1';
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
  const rows = await prisma.notification.findMany({
    where: { businessId: auth.businessId, userId: auth.userId, ...(onlyUnread ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return res.status(200).json(
    rows.map((n: any) => ({
      id: n.id,
      type: n.type,
      message: n.message,
      readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
      createdAt: new Date(n.createdAt).toISOString(),
    })),
  );
});

notificationsRouter.post('/mark-all-read', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  await prisma.notification.updateMany({
    where: { businessId: auth.businessId, userId: auth.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.status(200).json(true);
});

