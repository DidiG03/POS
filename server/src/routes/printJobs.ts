import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const printJobsRouter = Router();

const EnqueueSchema = z.object({
  type: z.enum(['RECEIPT', 'X_REPORT', 'Z_REPORT', 'TEST']).default('RECEIPT'),
  payload: z.any(),
  // When true, store the job for history but do NOT queue for printing.
  recordOnly: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

printJobsRouter.post('/enqueue', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const input = EnqueueSchema.parse(req.body || {});
  const headerKey = String(req.headers['idempotency-key'] || '').trim();
  const key = headerKey || String(input.idempotencyKey || '').trim();

  if (key) {
    const existing = await prisma.printJob.findFirst({ where: { businessId: auth.businessId, idempotencyKey: key } }).catch(() => null);
    if (existing) return res.status(200).json({ ok: true, deduped: true, id: existing.id });
  }

  const created = await prisma.printJob.create({
    data: {
      businessId: auth.businessId,
      type: input.type as any,
      payloadJson: input.payload as any,
      status: input.recordOnly ? ('SENT' as any) : ('QUEUED' as any),
      ...(key ? { idempotencyKey: key } : {}),
    } as any,
  });

  // If this is a payment receipt that includes a discount, create an admin-visible notification entry.
  try {
    const p: any = input.payload || {};
    const meta: any = p?.meta || {};
    const kind = String(meta?.kind || '');
    const userId = Number(meta?.userId || 0);
    const discountAmt = Number(meta?.discountAmount || 0);
    if (kind === 'PAYMENT' && userId && Number.isFinite(discountAmt) && discountAmt > 0) {
      const area = String(p?.area || '');
      const tableLabel = String(p?.tableLabel || '');
      const before = Number(meta?.totalBefore ?? meta?.total ?? 0);
      const after = Number(meta?.totalAfter ?? Math.max(0, before - discountAmt));
      const dtype = String(meta?.discountType || '').toUpperCase();
      const dval = meta?.discountValue;
      const dLabel =
        dtype === 'PERCENT' && Number.isFinite(Number(dval))
          ? `${Number(dval)}%`
          : dtype === 'AMOUNT' && Number.isFinite(Number(dval))
            ? `${Number(dval).toFixed(2)}`
            : 'custom';
      const reason = String(meta?.discountReason || '').trim();
      const approvedBy = String(meta?.managerApprovedByName || '').trim();
      const msg =
        `Discount applied (${dLabel}) on ${area} Table ${tableLabel}: -${discountAmt.toFixed(2)} ` +
        `(total ${before.toFixed(2)} → ${after.toFixed(2)})` +
        `${meta?.method ? ` · method ${String(meta.method)}` : ''}` +
        `${reason ? ` · reason: ${reason}` : ''}` +
        `${approvedBy ? ` · approved by: ${approvedBy}` : ' · NO MANAGER APPROVAL'}`;
      // Notify actor + all admins
      await prisma.notification.create({ data: { businessId: auth.businessId, userId, type: 'OTHER' as any, message: msg } as any });
      const admins = await prisma.user.findMany({ where: { businessId: auth.businessId, role: 'ADMIN', active: true } as any }).catch(() => []);
      for (const a of admins as any[]) {
        await prisma.notification.create({ data: { businessId: auth.businessId, userId: a.id, type: 'OTHER' as any, message: msg } as any }).catch(() => {});
      }
    }
  } catch {
    // ignore
  }
  return res.status(201).json({ ok: true, id: created.id });
});

printJobsRouter.get('/pending', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const rows = await prisma.printJob.findMany({
    where: { businessId: auth.businessId, status: 'QUEUED' as any },
    orderBy: { createdAt: 'asc' },
    take: limit,
  } as any);
  return res.status(200).json(
    rows.map((j: any) => ({
      id: j.id,
      type: j.type,
      payload: j.payloadJson,
      createdAt: j.createdAt.toISOString(),
    })),
  );
});

const AckSchema = z.object({
  status: z.enum(['SENT', 'FAILED']),
  error: z.string().max(500).optional(),
});

printJobsRouter.post('/:id/ack', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const input = AckSchema.parse(req.body || {});

  // Ensure tenant isolation by including businessId in the update filter.
  const updated = await prisma.printJob.updateMany({
    where: { businessId: auth.businessId, id },
    data: { status: input.status as any },
  } as any);

  if (!updated?.count) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
});

