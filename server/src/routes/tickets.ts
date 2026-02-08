import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';
import { verifyApprovalToken } from '../auth/jwt.js';

export const ticketsRouter = Router();

async function maybeAlertVoidSoonAfterPayment(input: {
  businessId: string;
  actorUserId: number;
  actorName?: string | null;
  area: string;
  tableLabel: string;
  kind: 'VOID_ITEM' | 'VOID_TICKET';
}) {
  const windowMinutes = 10;
  const cooldownMinutes = 60;
  const now = Date.now();
  const cooldownSince = new Date(now - cooldownMinutes * 60 * 1000);
  const key = `${input.area}:${input.tableLabel}`;

  const row = await prisma.syncState
    .findFirst({ where: { businessId: input.businessId, key: 'antitheft:lastPaymentAt' } as any })
    .catch(() => null as any);
  const map = ((row?.valueJson as any) || {}) as Record<string, string>;
  const lastIso = map[key];
  if (!lastIso) return;
  const last = new Date(lastIso);
  const deltaMs = now - last.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > windowMinutes * 60 * 1000) return;

  const admins = await prisma.user
    .findMany({
      where: { businessId: input.businessId, role: 'ADMIN', active: true } as any,
      select: { id: true },
      take: 50,
    })
    .catch(() => []);

  const actor = input.actorName ? String(input.actorName) : `User #${input.actorUserId}`;
  const minutesAgo = Math.max(0, Math.round(deltaMs / 60000));
  const actionLabel = input.kind === 'VOID_TICKET' ? 'voided a ticket' : 'voided an item';
  const msg =
    `Unusual activity (auto-check): ${actor} ${actionLabel} on ${input.area} Table ${input.tableLabel} about ${minutesAgo} minutes after payment. ` +
    `This can be normal (corrections/reprints); please review if unexpected.`;

  for (const a of admins as any[]) {
    const already = await prisma.notification
      .count({
        where: {
          businessId: input.businessId,
          userId: a.id,
          type: 'SECURITY' as any,
          createdAt: { gte: cooldownSince },
          message: { includes: 'minutes after payment' } as any,
        } as any,
      })
      .catch(() => 0);
    if (already > 0) continue;
    await prisma.notification
      .create({
        data: {
          businessId: input.businessId,
          userId: a.id,
          type: 'SECURITY' as any,
          message: msg,
        } as any,
      })
      .catch(() => {});
  }
}

async function maybeAlertSuspiciousVoids(input: {
  businessId: string;
  actorUserId: number;
  kind: 'VOID_ITEM' | 'VOID_TICKET';
}) {
  // Conservative thresholds to avoid false accusations.
  // We only alert on *unusual volume* of void actions in a short window.
  const windowMinutes = 60;
  const threshold = input.kind === 'VOID_TICKET' ? 3 : 6; // tickets are rarer than items
  const cooldownMinutes = 60; // don't spam admins repeatedly

  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const prefix = input.kind === 'VOID_TICKET' ? 'Voided ticket on ' : 'Voided item on ';

  const count = await prisma.notification
    .count({
      where: {
        businessId: input.businessId,
        userId: input.actorUserId,
        type: 'OTHER' as any,
        createdAt: { gte: since },
        message: { startsWith: prefix },
      } as any,
    })
    .catch(() => 0);

  if (count < threshold) return;

  const actor = await prisma.user
    .findFirst({
      where: { businessId: input.businessId, id: input.actorUserId } as any,
      select: { displayName: true },
    })
    .catch(() => null as any);
  const actorName = actor?.displayName ? String(actor.displayName) : `User #${input.actorUserId}`;

  const admins = await prisma.user
    .findMany({
      where: { businessId: input.businessId, role: 'ADMIN', active: true } as any,
      select: { id: true },
      take: 50,
    })
    .catch(() => []);

  const cooldownSince = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  const actionLabel = input.kind === 'VOID_TICKET' ? 'voided tickets' : 'voided items';
  const msg = `Unusual activity (auto-check): ${count} ${actionLabel} by ${actorName} in the last ${windowMinutes} minutes. This can be normal during corrections; please review if unexpected.`;

  for (const a of admins as any[]) {
    // Cooldown per admin to prevent notification spam
    const already = await prisma.notification
      .count({
        where: {
          businessId: input.businessId,
          userId: a.id,
          type: 'SECURITY' as any,
          createdAt: { gte: cooldownSince },
          message: { startsWith: 'Unusual activity (auto-check):' },
        } as any,
      })
      .catch(() => 0);
    if (already > 0) continue;
    await prisma.notification
      .create({
        data: {
          businessId: input.businessId,
          userId: a.id,
          type: 'SECURITY' as any,
          message: msg,
        } as any,
      })
      .catch(() => {});
  }
}

const TicketItemSchema = z.object({
  name: z.string().min(1),
  qty: z.number().int().positive().optional().default(1),
  unitPrice: z.number(),
  vatRate: z.number().optional(),
  note: z.string().optional(),
});

const LogTicketSchema = z.object({
  userId: z.number().int().positive(),
  area: z.string().min(1),
  tableLabel: z.string().min(1),
  covers: z.number().int().positive().nullable().optional(),
  items: z.array(TicketItemSchema).min(1),
  note: z.string().nullable().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

ticketsRouter.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = LogTicketSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.userId) return res.status(403).json({ error: 'forbidden' });

  const headerKey = String(req.headers['idempotency-key'] || '').trim();
  const key = headerKey || String(input.idempotencyKey || '').trim();
  if (key) {
    const existing = await prisma.ticketLog.findFirst({ where: { businessId: auth.businessId, idempotencyKey: key } }).catch(() => null);
    if (existing) return res.status(200).json({ ok: true, deduped: true, id: existing.id });
  }

  await prisma.ticketLog.create({
    data: {
      businessId: auth.businessId,
      userId: input.userId,
      area: input.area,
      tableLabel: input.tableLabel,
      covers: input.covers ?? null,
      itemsJson: input.items as any,
      note: input.note ?? null,
      ...(key ? { idempotencyKey: key } : {}),
    } as any,
  });
  return res.status(201).json({ ok: true });
});

ticketsRouter.get('/latest', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const area = String(req.query.area || '');
  const tableLabel = String((req.query.table as any) || (req.query.label as any) || '');
  if (!area || !tableLabel) return res.status(400).json({ error: 'invalid' });
  const last = await prisma.ticketLog.findFirst({
    where: { businessId: auth.businessId, area, tableLabel },
    orderBy: { createdAt: 'desc' },
  });
  if (!last) return res.status(200).json(null);
  const items = (((last.itemsJson as any) || []) as any[]).filter((it: any) => !it?.voided);
  return res.status(200).json({
    items,
    note: last.note ?? null,
    covers: last.covers ?? null,
    createdAt: last.createdAt.toISOString(),
    userId: last.userId,
  });
});

const VoidItemSchema = z.object({
  userId: z.number().int().positive(),
  area: z.string().min(1),
  tableLabel: z.string().min(1),
  item: z.object({ name: z.string().min(1), qty: z.number().optional(), unitPrice: z.number(), vatRate: z.number().optional(), note: z.string().optional() }),
  // Optional admin approval fields (required for non-admins).
  approvedByAdminId: z.number().int().positive().optional(),
  approvedByAdminName: z.string().max(80).optional(),
  approvedByAdminToken: z.string().min(10).max(2000).optional(),
});

ticketsRouter.post('/void-item', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = VoidItemSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.userId) return res.status(403).json({ error: 'forbidden' });

  // Require admin approval for non-admin users (defensive: enforce server-side even if UI is bypassed).
  if (auth.role !== 'ADMIN') {
    const tok = String((input as any).approvedByAdminToken || '').trim();
    const approved = tok ? verifyApprovalToken(tok) : null;
    if (!approved || approved.businessId !== auth.businessId) {
      return res.status(403).json({ error: 'admin_approval_required' });
    }
    const claimed = Number((input as any).approvedByAdminId || 0);
    if (claimed && claimed !== approved.userId) {
      return res.status(403).json({ error: 'admin_approval_required' });
    }
  }

  const message = `Voided item on ${input.area} ${input.tableLabel}: ${input.item.name} x${Number(input.item.qty || 1)}`;
  // Notify actor + all admins (anti-theft audit trail)
  await prisma.notification.create({ data: { businessId: auth.businessId, userId: input.userId, type: 'OTHER' as any, message } as any }).catch(() => {});
  const admins = await prisma.user.findMany({ where: { businessId: auth.businessId, role: 'ADMIN', active: true } as any }).catch(() => []);
  for (const a of admins as any[]) {
    await prisma.notification.create({ data: { businessId: auth.businessId, userId: a.id, type: 'OTHER' as any, message } as any }).catch(() => {});
  }

  const last = await prisma.ticketLog.findFirst({
    where: { businessId: auth.businessId, area: input.area, tableLabel: input.tableLabel },
    orderBy: { createdAt: 'desc' },
  });
  if (last) {
    const items = ((last.itemsJson as any[]) || []).slice();
    const idx = items.findIndex((it: any) => it?.name === input.item.name);
    if (idx !== -1) {
      items[idx] = { ...items[idx], voided: true };
      await prisma.ticketLog.update({ where: { id: last.id }, data: { itemsJson: items as any } });
    }
  }
  // Best-effort suspicious-pattern alerting (admins only; conservative thresholds).
  void maybeAlertSuspiciousVoids({
    businessId: auth.businessId,
    actorUserId: input.userId,
    kind: 'VOID_ITEM',
  });
  // Also alert if a void happens shortly after a payment (often rare; can indicate refunds/abuse or normal corrections).
  void maybeAlertVoidSoonAfterPayment({
    businessId: auth.businessId,
    actorUserId: input.userId,
    area: input.area,
    tableLabel: input.tableLabel,
    kind: 'VOID_ITEM',
  });
  return res.status(200).json({ ok: true });
});

const VoidTicketSchema = z.object({
  userId: z.number().int().positive(),
  area: z.string().min(1),
  tableLabel: z.string().min(1),
  reason: z.string().optional(),
  // Optional admin approval fields (required for non-admins).
  approvedByAdminId: z.number().int().positive().optional(),
  approvedByAdminName: z.string().max(80).optional(),
  approvedByAdminToken: z.string().min(10).max(2000).optional(),
});

ticketsRouter.post('/void-ticket', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = VoidTicketSchema.parse(req.body || {});
  if (auth.role !== 'ADMIN' && auth.userId !== input.userId) return res.status(403).json({ error: 'forbidden' });

  if (auth.role !== 'ADMIN') {
    const tok = String((input as any).approvedByAdminToken || '').trim();
    const approved = tok ? verifyApprovalToken(tok) : null;
    if (!approved || approved.businessId !== auth.businessId) {
      return res.status(403).json({ error: 'admin_approval_required' });
    }
    const claimed = Number((input as any).approvedByAdminId || 0);
    if (claimed && claimed !== approved.userId) {
      return res.status(403).json({ error: 'admin_approval_required' });
    }
  }

  const message = `Voided ticket on ${input.area} ${input.tableLabel}${input.reason ? `: ${input.reason}` : ''}`;
  // Notify actor + all admins (anti-theft audit trail)
  await prisma.notification.create({ data: { businessId: auth.businessId, userId: input.userId, type: 'OTHER' as any, message } as any }).catch(() => {});
  const admins = await prisma.user.findMany({ where: { businessId: auth.businessId, role: 'ADMIN', active: true } as any }).catch(() => []);
  for (const a of admins as any[]) {
    await prisma.notification.create({ data: { businessId: auth.businessId, userId: a.id, type: 'OTHER' as any, message } as any }).catch(() => {});
  }

  const last = await prisma.ticketLog.findFirst({
    where: { businessId: auth.businessId, area: input.area, tableLabel: input.tableLabel },
    orderBy: { createdAt: 'desc' },
  });
  if (last) {
    const items = ((last.itemsJson as any[]) || []).map((it: any) => ({ ...it, voided: true }));
    const note = last.note
      ? `${last.note} | VOIDED${input.reason ? `: ${input.reason}` : ''}`
      : `VOIDED${input.reason ? `: ${input.reason}` : ''}`;
    await prisma.ticketLog.update({ where: { id: last.id }, data: { itemsJson: items as any, note } });
  }

  // Also close the table immediately so it doesn't remain "occupied" after voiding.
  try {
    const k = `${input.area}:${input.tableLabel}`;
    const [openRow, atRow] = await Promise.all([
      prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:open' } }).catch(() => null),
      prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:openAt' } }).catch(() => null),
    ]);
    const openMap = ((openRow?.valueJson as any) || {}) as Record<string, boolean>;
    const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
    delete openMap[k];
    delete atMap[k];
    await Promise.all([
      prisma.syncState.upsert({ where: { id: openRow?.id || 0 } as any, create: { businessId: auth.businessId, key: 'tables:open', valueJson: openMap } as any, update: { valueJson: openMap } as any }).catch(() =>
        prisma.syncState.create({ data: { businessId: auth.businessId, key: 'tables:open', valueJson: openMap } as any }).catch(() => null),
      ),
      prisma.syncState.upsert({ where: { id: atRow?.id || 0 } as any, create: { businessId: auth.businessId, key: 'tables:openAt', valueJson: atMap } as any, update: { valueJson: atMap } as any }).catch(() =>
        prisma.syncState.create({ data: { businessId: auth.businessId, key: 'tables:openAt', valueJson: atMap } as any }).catch(() => null),
      ),
    ]);
  } catch {
    // ignore
  }
  // Best-effort suspicious-pattern alerting (admins only; conservative thresholds).
  void maybeAlertSuspiciousVoids({
    businessId: auth.businessId,
    actorUserId: input.userId,
    kind: 'VOID_TICKET',
  });
  void maybeAlertVoidSoonAfterPayment({
    businessId: auth.businessId,
    actorUserId: input.userId,
    area: input.area,
    tableLabel: input.tableLabel,
    kind: 'VOID_TICKET',
  });
  return res.status(200).json({ ok: true });
});

// Tooltip stats for a table: covers, first ticket time, latest total (only for currently open tables)
ticketsRouter.get('/tooltip', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const area = String(req.query.area || '');
  const tableLabel = String(req.query.tableLabel || req.query.table || req.query.label || '');
  if (!area || !tableLabel) return res.status(400).json({ error: 'invalid' });

  // Show only for currently open tables
  const openRow = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:open' } }).catch(() => null);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<string, boolean>;
  const k = `${area}:${tableLabel}`;
  if (!openMap[k]) return res.status(200).json(null);

  const atRow = await prisma.syncState.findFirst({ where: { businessId: auth.businessId, key: 'tables:openAt' } }).catch(() => null);
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const sinceIso = atMap[k];
  const since = sinceIso ? new Date(sinceIso) : null;

  const where: any = { businessId: auth.businessId, area, tableLabel };
  if (since) where.createdAt = { gte: since };

  const [last, coversRow] = await Promise.all([
    prisma.ticketLog.findFirst({ where, orderBy: { createdAt: 'desc' } }),
    prisma.covers.findFirst({
      where: { businessId: auth.businessId, area, label: tableLabel, ...(since ? { createdAt: { gte: since } as any } : {}) },
      orderBy: { id: 'desc' },
    } as any),
  ]);

  const items = ((last?.itemsJson as any[]) || []).filter((it: any) => !it?.voided);
  const total = items.reduce((s: number, it: any) => s + Number(it?.unitPrice || 0) * Number(it?.qty || 1), 0);
  const firstAt = since ? since.toISOString() : last ? new Date(last.createdAt).toISOString() : null;

  return res.status(200).json({ covers: coversRow?.covers ?? null, firstAt, total });
});
