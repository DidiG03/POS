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
 * its own new docId, referencing the original invoice's IIC. A CORRECTIVE
 * files a restated invoice for the surviving lines the same way. The review
 * queue is the fallback when the API does not confirm, when the IIC was
 * never recorded, or when a P9 e-invoice is missing buyer details.
 */
import { prisma } from '@db/client';
import { coreServices } from './core';
import { notifyAdminsAndActor } from './adminAlerts';
import { flagFiscalCorrectionRequired } from './fiscal/claims';
import { cancelInvoice } from './fiscal/cancel';
import { registerCorrectiveInvoice } from './fiscal/corrective';
import { isFiscalEnabled } from './fiscal';
import { newDocId } from './fiscal/docId';
import { assertVatCode } from './fiscal/vatConfig';
import { mapPaymentMethod } from './fiscal/paymentMethod';
import { roundMoney } from '@shared/pricing';
import {
  planSaleCorrection,
  type SaleCorrectionError,
  type SaleCorrectionKind,
} from '@shared/saleCorrection';
import { tinFromVerifyUrl } from '@shared/fiscalReceipt';

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
  /** Official CIS / easyPos verification URL when the provider returned one. */
  fiscalLink: string | null;
  /** Provider QR payload when it is a URL, not an image dump. */
  fiscalQrCode: string | null;
  /** Seller NIPT — CIS InvoiceCheck requires this next to the IIC. */
  fiscalTin: string | null;
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
    /** IIC of the cancellation / corrective invoice, once CIS accepted it. */
    correctionNslf: string | null;
    /** FIC of the cancellation / corrective invoice. */
    correctionNivf: string | null;
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

function paymentMeta(payment: any): Record<string, unknown> {
  const raw = payment?.metaJson;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function pickFiscalField(
  payment: any,
  key: 'fiscalLink' | 'fiscalQrCode' | 'fiscalTin',
): string | null {
  const meta = paymentMeta(payment);
  const value = String(meta[key] || '').trim();
  return value || null;
}

function pickFiscalTin(payment: any, fallbackTin?: string): string | null {
  return (
    pickFiscalField(payment, 'fiscalTin') ||
    tinFromVerifyUrl(pickFiscalField(payment, 'fiscalLink')) ||
    tinFromVerifyUrl(pickFiscalField(payment, 'fiscalQrCode')) ||
    String(fallbackTin || '').trim() ||
    null
  );
}

/** Shape `listFiscalizedSales` / ticket matching both read off an Order. */
export function mapOrderToFiscalSaleRow(
  row: any,
  options?: { tin?: string | null },
): FiscalSaleRow {
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
    fiscalLink: pickFiscalField(payment, 'fiscalLink'),
    fiscalQrCode: pickFiscalField(payment, 'fiscalQrCode'),
    fiscalTin: pickFiscalTin(payment, options?.tin || undefined),
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
        correctionNslf: String(c.correctionNslf || '').trim() || null,
        correctionNivf: String(c.correctionNivf || '').trim() || null,
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

  const tin = String(
    ((await coreServices.readSettings().catch(() => ({}))) as any)?.fiscal
      ?.nipt || '',
  ).trim();
  return (rows as any[]).map((row) => mapOrderToFiscalSaleRow(row, { tin }));
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
      /** Present when a partial corrective was filed (or attempted) automatically. */
      corrective?: FiledCancellation;
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
  /** NSLF of the cancellation / corrective document. */
  nslf?: string;
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
        nslf: outcome.identifiers.iic,
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

async function stampFiledCorrection(
  correctionId: number,
  filed: FiledCancellation,
): Promise<void> {
  await prisma.saleCorrection
    .update({
      where: { id: correctionId },
      data: {
        filedAt: new Date(),
        correctionNslf: String(filed.nslf || '').trim() || null,
        correctionNivf: String(filed.nivf || '').trim() || null,
      },
    })
    .catch(() => undefined);
}

const CANCELLATION_DOC_KEY = (orderId: number) =>
  `fiscal:cancel-docid:${orderId}`;
const CORRECTIVE_DOC_KEY = (orderId: number, correctionId: number) =>
  `fiscal:corrective-docid:${orderId}:${correctionId}`;

async function writeDocId(key: string, docId: string): Promise<void> {
  const valueJson = { docId, createdAt: new Date().toISOString() } as any;
  await prisma.syncState.upsert({
    where: { key },
    create: { key, valueJson },
    update: { valueJson },
  });
}

async function readDocId(key: string): Promise<string> {
  const row = await prisma.syncState
    .findUnique({ where: { key } })
    .catch(() => null);
  return String((row as any)?.valueJson?.docId || '').trim();
}

async function readCancellationDocId(orderId: number): Promise<string> {
  return readDocId(CANCELLATION_DOC_KEY(orderId));
}

async function writeCancellationDocId(
  orderId: number,
  docId: string,
): Promise<void> {
  await writeDocId(CANCELLATION_DOC_KEY(orderId), docId);
}

async function fileCorrective(input: {
  settings: any;
  orderId: number;
  correctionId: number;
  originalDocId: string;
  iic: string;
  eic?: string;
  issueDateTime?: string;
  remaining: Array<{
    sku?: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
  }>;
  nextTotal: number;
  method: string;
}): Promise<FiledCancellation> {
  const key = CORRECTIVE_DOC_KEY(input.orderId, input.correctionId);
  const existing = await readDocId(key);
  const docId = existing || newDocId('invoice');
  if (!existing) {
    await writeDocId(key, docId).catch(() => undefined);
  }

  try {
    const soldIn =
      String(input.settings?.fiscal?.defaultSoldIn || 'XPP').trim() || 'XPP';
    const articles = input.remaining
      .filter((it) => Number.isFinite(it.qty) && it.qty > 0)
      .map((it) => ({
        articleId:
          String(it.sku || '').trim() || `ITEM-${it.name.slice(0, 24)}`,
        vatCode: assertVatCode(input.settings, {
          vatRate: it.vatRate,
          articleName: it.name,
        }),
        name: String(it.name || 'Item').slice(0, 100),
        soldIn,
        price: Number(it.unitPrice),
        units: Number(it.qty),
      }));
    if (articles.length === 0) {
      return {
        state: 'NOT_FILED',
        docId,
        detail: 'Corrective invoice has no remaining lines to file.',
      };
    }
    const lineSum = roundMoney(
      articles.reduce((sum, a) => sum + a.price * a.units, 0),
    );
    const nextTotal = roundMoney(input.nextTotal);
    const rebateGap = roundMoney(lineSum - nextTotal);
    const invoiceRebate =
      rebateGap >= 0.01 ? { inValue: rebateGap } : undefined;
    const method = mapPaymentMethod(input.method || 'CASH');
    const outcome = await registerCorrectiveInvoice(input.settings, {
      docId,
      articles,
      payment: [{ type: method as any, amount: nextTotal }],
      invoiceRebate,
      original: {
        iic: input.iic,
        eic: input.eic,
        issueDateTime: input.issueDateTime,
      },
    });
    if (outcome.kind === 'complete') {
      return {
        state: 'FILED',
        docId,
        nslf: outcome.identifiers.iic,
        nivf: outcome.identifiers.fic,
        detail: `Corrective filed · NIVF ${outcome.identifiers.fic} · docId ${docId}`,
      };
    }
    if (outcome.kind === 'unresolved') {
      return {
        state: 'UNCONFIRMED',
        docId,
        detail: `Corrective outcome unconfirmed — check docId ${docId} in easyPos before filing another: ${outcome.message}`,
      };
    }
    return {
      state: 'NOT_FILED',
      docId,
      detail: `Corrective was not filed: ${outcome.message}`,
    };
  } catch (e: any) {
    return {
      state: 'NOT_FILED',
      docId,
      detail: `Corrective could not be sent: ${String(e?.message || e)}`,
    };
  }
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
  let corrective: FiledCancellation | null = null;
  if (wasFiscalized && docId) {
    const iic = String(payment?.fiscalNslf || '').trim();
    if (plan.cancelsSale && iic && isFiscalEnabled(settings)) {
      cancellation = await fileCancellation({
        settings,
        orderId,
        originalDocId: docId,
        iic,
        eic: String(payment?.fiscalEic || '').trim() || undefined,
        issueDateTime: iso(payment?.paidAt) || undefined,
      });
    } else if (!plan.cancelsSale && iic && isFiscalEnabled(settings)) {
      const struck = new Set(plan.struckItemIds);
      const remaining = ((order as any).items || [])
        .filter((it: any) => !struck.has(Number(it.id)) && it.voidedAt == null)
        .map((it: any) => ({
          sku: String(it.sku || ''),
          name: String(it.name || 'Item'),
          qty: num(it.qty),
          unitPrice: num(it.unitPrice),
          vatRate: num(it.vatRate),
        }));
      corrective = await fileCorrective({
        settings,
        orderId,
        correctionId,
        originalDocId: docId,
        iic,
        eic: String(payment?.fiscalEic || '').trim() || undefined,
        issueDateTime: iso(payment?.paidAt) || undefined,
        remaining,
        nextTotal: plan.nextTotal,
        method: String(payment?.method || 'CASH'),
      });
    }

    const filed =
      cancellation?.state === 'FILED' || corrective?.state === 'FILED';
    if (filed) {
      await stampFiledCorrection(
        correctionId,
        (cancellation?.state === 'FILED' ? cancellation : corrective)!,
      );
    } else {
      needsFiling = await flagFiscalCorrectionRequired({
        idempotencyKey: docId,
        reason:
          `${what}: ${plan.reason} (${plan.amountDelta})` +
          (cancellation
            ? ` · ${cancellation.detail}`
            : corrective
              ? ` · ${corrective.detail}`
              : ''),
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
    ...(corrective ? { corrective } : {}),
  };
}
