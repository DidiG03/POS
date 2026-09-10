/**
 * Reversing a settled sale from the admin panel.
 *
 * Nothing here deletes anything. The sale, its lines and its payment stay
 * exactly as they were filed — a cancellation flips the order to VOID (which
 * is what drops it out of every report, since they all read `status: 'PAID'`)
 * and a corrective marks the struck lines and restates the totals. What was
 * reversed, by whom, on whose approval and against which invoice lands in
 * `SaleCorrection`.
 *
 * The fiscal document is filed too. This used to say easyPos' cloud API had
 * no route for a cancellation, which was simply wrong — `POST
 * /invoice/cancel` exists — and the cost of the mistake was that every void
 * of a fiscalized sale only ever raised a note asking an admin to go and do
 * it by hand. Until somebody did, the tax service held an invoice for money
 * the venue had not taken.
 *
 * So a CANCEL of a fiscalized sale now files the cancellation itself, under
 * its own new docId, referencing the original invoice's IIC. The review
 * queue is still the fallback for everything that cannot be filed
 * automatically: a partial corrective (which needs a restated invoice
 * rather than a cancellation), a sale whose IIC was never recorded, and any
 * cancellation the API does not confirm.
 */
import { prisma } from '@db/client';
import { coreServices } from './core';
import { notifyAdminsAndActor } from './adminAlerts';
import { flagFiscalCorrectionRequired } from './fiscal/claims';
import { cancelInvoice } from './fiscal/cancel';
import { isFiscalEnabled } from './fiscal';
import { newDocId } from './fiscal/docId';
import {
  planSaleCorrection,
  type SaleCorrectionError,
  type SaleCorrectionKind,
} from '@shared/saleCorrection';

export type FiscalSaleRow = {
  orderId: number;
  closedAt: string | null;
  area: string;
  tableLabel: string;
  userName: string;
  total: number;
  method: string;
  status: string;
  fiscalNslf: string | null;
  fiscalNivf: string | null;
  /** Set only for electronic invoices; decides whether P10 is possible. */
  fiscalEic: string | null;
  /** easyPos docId for the invoice — the payment's idempotency key. */
  docId: string | null;
  items: Array<{
    id: number;
    name: string;
    qty: number;
    unitPrice: number;
    voided: boolean;
  }>;
  corrections: Array<{
    id: number;
    kind: SaleCorrectionKind;
    reason: string;
    amountDelta: number;
    filedAt: string | null;
    createdAt: string;
  }>;
};

function num(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function iso(raw: unknown): string | null {
  if (raw instanceof Date) return raw.toISOString();
  const s = String(raw || '').trim();
  return s || null;
}

const FISCAL_SALE_INCLUDE = {
  items: { orderBy: { sortOrder: 'asc' as const } },
  payments: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  corrections: { orderBy: { createdAt: 'desc' as const } },
};

/** Shape `listFiscalizedSales` / ticket matching both read off an Order. */
export function mapOrderToFiscalSaleRow(row: any): FiscalSaleRow {
  const payment = Array.isArray(row?.payments) ? row.payments[0] : null;
  return {
    orderId: Number(row.id),
    closedAt: iso(row.closedAt),
    area: String(row.area || ''),
    tableLabel: String(row.tableLabel || ''),
    userName: String(row.userName || ''),
    total: num(row.total),
    method: String(payment?.method || ''),
    status: String(row.status || ''),
    fiscalNslf: String(payment?.fiscalNslf || '').trim() || null,
    fiscalNivf: String(payment?.fiscalNivf || '').trim() || null,
    fiscalEic: String(payment?.fiscalEic || '').trim() || null,
    docId: String(payment?.idempotencyKey || '').trim() || null,
    items: (Array.isArray(row.items) ? row.items : []).map((it: any) => ({
      id: Number(it.id),
      name: String(it.name || 'Item'),
      qty: num(it.qty),
      unitPrice: num(it.unitPrice),
      voided: it.voidedAt != null,
    })),
    corrections: (Array.isArray(row.corrections) ? row.corrections : []).map(
      (c: any) => ({
        id: Number(c.id),
        kind: String(c.kind) as SaleCorrectionKind,
        reason: String(c.reason || ''),
        amountDelta: num(c.amountDelta),
        filedAt: iso(c.filedAt),
        createdAt: iso(c.createdAt) || '',
      }),
    ),
  };
}

/**
 * Sales an admin might need to reverse: settled, newest first, with the
 * fiscal identifiers the corrective document has to reference.
 */
export async function listFiscalizedSales(args?: {
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<FiscalSaleRow[]> {
  const take = Math.min(Math.max(Number(args?.limit) || 50, 1), 200);
  const where: Record<string, unknown> = {
    status: { in: ['PAID', 'VOID'] },
  };
  if (args?.from || args?.to) {
    where.closedAt = {
      ...(args?.from ? { gte: args.from } : {}),
      ...(args?.to ? { lte: args.to } : {}),
    };
  }

  const rows = await prisma.order
    .findMany({
      where: where as any,
      orderBy: { closedAt: 'desc' },
      take,
      include: FISCAL_SALE_INCLUDE as any,
    })
    .catch(() => [] as any[]);

  return (rows as any[]).map(mapOrderToFiscalSaleRow);
}

export type ApplyCorrectionResult =
  | {
      ok: true;
      correctionId: number;
      kind: SaleCorrectionKind;
      amountDelta: number;
      /** The corrective document still has to be filed with the tax service. */
      needsFiling: boolean;
      /** Present when a cancellation was filed (or attempted) automatically. */
      cancellation?: FiledCancellation;
    }
  | { ok: false; error: SaleCorrectionError | 'not-found' };

export interface FiledCancellation {
  /**
   * `FILED` — the tax service confirmed it, so nothing is owed.
   * `NOT_FILED` — provably not filed; the review queue explains why.
   * `UNCONFIRMED` — outcome unknown. Must be reconciled by a person, and
   *   must NOT be retried automatically: the cancellation may exist.
   */
  state: 'FILED' | 'NOT_FILED' | 'UNCONFIRMED';
  /** The cancellation's own docId, so it can be looked up or resumed. */
  docId: string;
  /** NIVF of the cancellation document. */
  nivf?: string;
  detail: string;
}

/**
 * File the cancellation for a voided fiscalized sale.
 *
 * The cancellation is its own business document: a NEW docId, referencing
 * the original invoice by IIC. It is persisted against the order before the
 * request goes out so a crash mid-flight can be resumed under the same
 * docId rather than filing a second cancellation.
 *
 * Never throws. A void must not be blocked by the tax service being down —
 * an unfiled cancellation goes to the review queue, which is where an
 * unreconciled document belongs anyway.
 */
async function fileCancellation(input: {
  settings: any;
  orderId: number;
  originalDocId: string;
  iic: string;
  eic?: string;
  issueDateTime?: string;
}): Promise<FiledCancellation> {
  const existing = await readCancellationDocId(input.orderId);
  const docId = existing || newDocId('cancellation');
  if (!existing) {
    // Persisted BEFORE the POST, like every other fiscal docId.
    await writeCancellationDocId(input.orderId, docId).catch(() => undefined);
  }

  try {
    const outcome = await cancelInvoice(input.settings, {
      docId,
      target: {
        iic: input.iic,
        eic: input.eic,
        issueDateTime: input.issueDateTime,
      },
      originalDocId: input.originalDocId,
      // Only electronic when the original actually carries an EIC — a P10
      // against a non-electronic invoice is rejected by the tax service.
      electronic: Boolean(input.eic),
    });

    if (outcome.kind === 'complete') {
      return {
        state: 'FILED',
        docId,
        nivf: outcome.identifiers.fic,
        detail: `Cancellation filed · NIVF ${outcome.identifiers.fic} · docId ${docId}`,
      };
    }
    if (outcome.kind === 'unresolved') {
      return {
        state: 'UNCONFIRMED',
        docId,
        detail: `Cancellation outcome unconfirmed — check docId ${docId} in easyPos before filing another: ${outcome.message}`,
      };
    }
    return {
      state: 'NOT_FILED',
      docId,
      detail: `Cancellation was not filed: ${outcome.message}`,
    };
  } catch (e: any) {
    return {
      state: 'NOT_FILED',
      docId,
      detail: `Cancellation could not be sent: ${String(e?.message || e)}`,
    };
  }
}

const CANCELLATION_DOC_KEY = (orderId: number) =>
  `fiscal:cancel-docid:${orderId}`;

async function readCancellationDocId(orderId: number): Promise<string> {
  const row = await prisma.syncState
    .findUnique({ where: { key: CANCELLATION_DOC_KEY(orderId) } })
    .catch(() => null);
  return String((row as any)?.valueJson?.docId || '').trim();
}

async function writeCancellationDocId(
  orderId: number,
  docId: string,
): Promise<void> {
  const key = CANCELLATION_DOC_KEY(orderId);
  const valueJson = { docId, createdAt: new Date().toISOString() } as any;
  await prisma.syncState.upsert({
    where: { key },
    create: { key, valueJson },
    update: { valueJson },
  });
}

export async function applySaleCorrection(input: {
  orderId: number;
  kind: SaleCorrectionKind;
  itemIds?: readonly number[] | null;
  reason: string;
  actorUserId?: number | null;
  approvedById?: number | null;
}): Promise<ApplyCorrectionResult> {
  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return { ok: false, error: 'not-found' };
  }

  const order = await prisma.order
    .findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      } as any,
    })
    .catch(() => null);
  if (!order) return { ok: false, error: 'not-found' };

  const settings: any = await coreServices.readSettings().catch(() => ({}));
  const planned = planSaleCorrection(
    {
      status: (order as any).status,
      total: num((order as any).total),
      vatEnabled: (order as any).vatEnabled === true,
      items: ((order as any).items || []).map((it: any) => ({
        id: Number(it.id),
        name: String(it.name || ''),
        qty: num(it.qty),
        unitPrice: num(it.unitPrice),
        vatRate: num(it.vatRate),
        voidedAt: it.voidedAt ?? null,
      })),
    },
    { kind: input.kind, itemIds: input.itemIds, reason: input.reason },
    { defaultVatRate: Number(settings?.defaultVatRate || 0) },
  );
  if (!planned.ok) return { ok: false, error: planned.error };
  const plan = planned.plan;

  const payment = Array.isArray((order as any).payments)
    ? (order as any).payments[0]
    : null;
  const now = new Date();

  const correctionId = await prisma.$transaction(async (tx: any) => {
    if (plan.struckItemIds.length > 0) {
      await tx.orderItem.updateMany({
        where: { id: { in: plan.struckItemIds }, orderId },
        data: { voidedAt: now },
      });
    }
    if (plan.cancelsSale) {
      // The filed figures are left alone: VOID is what excludes the sale, and
      // an audit needs to still show what the guest was charged.
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'VOID', voidedAt: now },
      });
    } else {
      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: plan.nextSubtotal,
          vatAmount: plan.nextVat,
          total: plan.nextTotal,
        },
      });
    }
    const created = await tx.saleCorrection.create({
      data: {
        orderId,
        kind: plan.kind,
        reason: plan.reason,
        amountDelta: plan.amountDelta,
        itemsJson: plan.struckLines.map((l) => ({
          id: l.id,
          name: l.name || '',
          qty: num(l.qty),
          unitPrice: num(l.unitPrice),
        })),
        actorUserId: Number(input.actorUserId) || null,
        approvedById: Number(input.approvedById) || null,
        originalNslf: String(payment?.fiscalNslf || '').trim() || null,
        originalNivf: String(payment?.fiscalNivf || '').trim() || null,
      },
      select: { id: true },
    });
    return Number(created.id);
  });

  const wasFiscalized = Boolean(
    String(payment?.fiscalNslf || '').trim() ||
      String(payment?.fiscalNivf || '').trim(),
  );
  const docId = String(payment?.idempotencyKey || '').trim();
  const what =
    plan.kind === 'CANCEL'
      ? 'Cancellation invoice required'
      : `Corrective invoice required for ${plan.struckLines.length} line(s)`;
  const where = [
    (order as any).area,
    (order as any).tableLabel && `Table ${(order as any).tableLabel}`,
  ]
    .filter(Boolean)
    .join(' ');

  let needsFiling = false;
  let cancellation: FiledCancellation | null = null;
  if (wasFiscalized && docId) {
    const iic = String(payment?.fiscalNslf || '').trim();
    /**
     * A full cancellation is the only correction the API can file for us.
     * A partial corrective restates an invoice rather than withdrawing it,
     * which needs the restated lines as a new document — so those still go
     * to a person.
     */
    if (plan.cancelsSale && iic && isFiscalEnabled(settings)) {
      cancellation = await fileCancellation({
        settings,
        orderId,
        originalDocId: docId,
        iic,
        eic: String(payment?.fiscalEic || '').trim() || undefined,
        issueDateTime: iso(payment?.paidAt) || undefined,
      });
    }

    if (!cancellation || cancellation.state !== 'FILED') {
      // Reuses the queue and the "mark corrective filed" button that already
      // exist in Settings › Fiskalizimi.
      needsFiling = await flagFiscalCorrectionRequired({
        idempotencyKey: docId,
        reason:
          `${what}: ${plan.reason} (${plan.amountDelta})` +
          (cancellation ? ` · ${cancellation.detail}` : ''),
        actorUserId: Number(input.actorUserId) || undefined,
        context: {
          area: String((order as any).area || ''),
          tableLabel: String((order as any).tableLabel || ''),
          total: num((order as any).total),
        },
        result: {
          nslf: iic || undefined,
          nivf: String(payment?.fiscalNivf || '').trim() || undefined,
          eic: String(payment?.fiscalEic || '').trim() || undefined,
        },
      }).catch(() => false);
    }
  } else {
    // Never fiscalized, so there is no document to correct — but a reversed
    // sale is still something every admin should see.
    await notifyAdminsAndActor({
      message:
        `Sale #${orderId} reversed${where ? ` (${where})` : ''}: ${plan.reason}` +
        ` · ${plan.amountDelta}`,
      actorUserId: Number(input.actorUserId) || undefined,
      type: 'SECURITY',
    }).catch(() => undefined);
  }

  return {
    ok: true,
    correctionId,
    kind: plan.kind,
    amountDelta: plan.amountDelta,
    needsFiling,
    ...(cancellation ? { cancellation } : {}),
  };
}
