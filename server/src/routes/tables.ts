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

const TransferSchema = z.object({
  fromArea: z.string().min(1),
  fromLabel: z.string().min(1),
  toArea: z.string().min(1).optional().nullable(),
  toLabel: z.string().min(1).optional().nullable(),
  toUserId: z.number().int().positive().optional().nullable(),
  actorUserId: z.number().int().positive(),
  actorRole: z.string().optional(),
});

// Transfer table: move ticket to new table and/or change owner. Always keeps same waiter when only moving table.
tablesRouter.post('/transfer', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = TransferSchema.parse(req.body || {});
  const fromArea = String(input.fromArea || '').trim();
  const fromLabel = String(input.fromLabel || '').trim();
  const toArea = String(input.toArea || fromArea || '').trim();
  const toLabel = String(input.toLabel || fromLabel || '').trim();
  const actorUserId = Number(input.actorUserId || 0);
  const toUserId = input.toUserId == null ? null : Number(input.toUserId || 0);

  if (!fromArea || !fromLabel || !actorUserId || !toArea || !toLabel) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }
  if (auth.role !== 'ADMIN' && auth.userId !== actorUserId) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  // SECURITY: Never trust client-supplied actorRole. The role MUST come from the
  // authenticated user record in the database. If the user row is missing or
  // inactive, refuse the operation.
  const actor = await prisma.user
    .findFirst({ where: { businessId: auth.businessId, id: actorUserId } as any })
    .catch(() => null);
  if (!actor || actor.active === false) {
    return res.status(403).json({ ok: false, error: 'Actor not found or inactive' });
  }

  const last = await prisma.ticketLog.findFirst({
    where: { businessId: auth.businessId, area: fromArea, tableLabel: fromLabel } as any,
    orderBy: { createdAt: 'desc' },
  });
  if (!last) return res.status(400).json({ ok: false, error: 'No active ticket found for this table' });

  const currentOwnerId = Number(last.userId || 0);
  const isAdmin = String((actor as any).role || '').toUpperCase() === 'ADMIN';
  if (!isAdmin && Number(actorUserId) !== Number(currentOwnerId)) {
    return res.status(403).json({ ok: false, error: 'Only the table owner or an admin can transfer a table' });
  }

  let newOwner: any = null;
  if (toUserId != null) {
    newOwner = await prisma.user
      .findFirst({ where: { businessId: auth.businessId, id: toUserId } as any })
      .catch(() => null);
    if (!newOwner || newOwner.active === false) {
      return res.status(400).json({ ok: false, error: 'Target waiter not found' });
    }
  }

  const movingTable = fromArea !== toArea || fromLabel !== toLabel;
  const changingOwner = toUserId != null && Number(toUserId) !== Number(currentOwnerId);
  if (!movingTable && !changingOwner) return res.status(200).json({ ok: true });

  const key = 'tables:open';
  const keyAt = 'tables:openAt';
  const [openRow, atRow] = await Promise.all([
    prisma.syncState.findFirst({ where: { businessId: auth.businessId, key } }).catch(() => null),
    prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: keyAt } }).catch(() => null),
  ]);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<string, boolean>;
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const fromKey = `${fromArea}:${fromLabel}`;
  const toKey = `${toArea}:${toLabel}`;

  if (movingTable && openMap[toKey]) {
    return res.status(400).json({ ok: false, error: `Destination table ${toArea} ${toLabel} is already open` });
  }

  const note = String(last.note || '');
  const transferTag = movingTable
    ? `[TRANSFER] ${fromArea} ${fromLabel} → ${toArea} ${toLabel}${changingOwner ? ` (owner → ${newOwner?.displayName || toUserId})` : ''}`
    : `[TRANSFER] owner → ${newOwner?.displayName || toUserId}`;
  const nextNote = note ? `${note}\n${transferTag}` : transferTag;

  // Keep same waiter when only moving table; change owner only when explicitly transferring to another waiter
  const nextUserId = changingOwner ? Number(toUserId) : Number(currentOwnerId);

  await prisma.ticketLog.create({
    data: {
      businessId: auth.businessId,
      userId: nextUserId,
      area: toArea,
      tableLabel: toLabel,
      covers: last.covers ?? null,
      itemsJson: last.itemsJson as any,
      note: nextNote,
    } as any,
  });

  if (movingTable) {
    delete openMap[fromKey];
    openMap[toKey] = true;
    const fromAt = atMap[fromKey];
    delete atMap[fromKey];
    atMap[toKey] = fromAt || new Date().toISOString();
    await Promise.all([
      prisma.syncState.upsert({
        where: { businessId_key: { businessId: auth.businessId, key } },
        create: { businessId: auth.businessId, key, valueJson: openMap },
        update: { valueJson: openMap },
      }),
      prisma.syncState.upsert({
        where: { businessId_key: { businessId: auth.businessId, key: keyAt } },
        create: { businessId: auth.businessId, key: keyAt, valueJson: atMap },
        update: { valueJson: atMap },
      }),
    ]);

    await prisma.ticketRequest
      .updateMany({
        where: {
          businessId: auth.businessId,
          area: fromArea,
          tableLabel: fromLabel,
          status: { in: ['PENDING', 'APPROVED'] as any },
        } as any,
        data: { area: toArea, tableLabel: toLabel },
      } as any)
      .catch(() => null);

    try {
      const active = await (prisma as any).kdsOrder.findFirst({
        where: { businessId: auth.businessId, area: fromArea, tableLabel: fromLabel, closedAt: null } as any,
        orderBy: { openedAt: 'desc' },
      });
      if (active) {
        await (prisma as any).kdsOrder.update({
          where: { id: active.id },
          data: { area: toArea, tableLabel: toLabel },
        });
      }
    } catch {
      // ignore
    }
  }

  if (changingOwner) {
    await prisma.ticketRequest
      .updateMany({
        where: {
          businessId: auth.businessId,
          area: toArea,
          tableLabel: toLabel,
          status: { in: ['PENDING', 'APPROVED'] as any },
        } as any,
        data: { ownerId: Number(toUserId) },
      } as any)
      .catch(() => null);

    const msg = movingTable
      ? `Table transferred to you: ${fromArea} ${fromLabel} → ${toArea} ${toLabel}`
      : `Table transferred to you: ${toArea} ${toLabel}`;
    await prisma.notification
      .create({
        data: {
          businessId: auth.businessId,
          userId: Number(toUserId),
          type: 'OTHER' as any,
          message: msg,
        } as any,
      })
      .catch(() => null);
  }

  return res.status(200).json({ ok: true });
});

