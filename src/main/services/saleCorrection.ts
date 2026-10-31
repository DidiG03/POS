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
import {
  abandonUnsentFiscalClaimUnlocked,
  annotateFiscalClaimUnlocked,
  createDeferredFiscalClaim,
  flagFiscalCorrectionRequired,
  isDeadPendingClaim,
  markDeadPendingUnknownUnlocked,
  parkUnconfirmedClaimUnlocked,
  readFiscalClaim,
  resolveFiscalClaim,
  settleFiscalClaimRegistered,
  withFiscalClaimLock,
  type FiscalClaimRecord,
} from './fiscal/claims';
import {
  buildEasyPosInvoiceDraft,
  buildCorrectionDifferenceLines,
  invoiceBandTotals,
  bandChangeBetween,
  invoiceInLek,
} from './fiscal/mapInvoice';
import { cancelInvoice } from './fiscal/cancel';
import { checkFiscalDocStatus } from './fiscal/easypos';
import { registerCorrectiveInvoice } from './fiscal/corrective';
import { isFiscalEnabled } from './fiscal';
import { fiscalConfig } from './fiscal/config';
import {
  isLeftoverTestWork,
  sameFiscalEnvironment,
} from './fiscal/environment';
import { docIdFromKey, newDocId } from './fiscal/docId';
import { mapPaymentMethod } from './fiscal/paymentMethod';
import { roundMoney } from '@shared/pricing';
import {
  planSaleCorrection,
  type SaleCorrectionError,
  type SaleCorrectionKind,
} from '@shared/saleCorrection';
import { tinFromVerifyUrl } from '@shared/fiscalReceipt';
import { restockMenuStockForLines } from './menuStock';

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
  /** Fiskalizimi was on for this sale and its invoice is not registered yet. */
  fiscalPending: boolean;
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
    fiscalPending:
      paymentMeta(payment).fiscalEnabled === true &&
      !String(payment?.fiscalNivf || '').trim(),
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
  /** Verification link / QR payload of the filed document, for its slip. */
  link?: string;
  qrCode?: string;
  /** FILED corrective: the amount filed, in lekë (negative). */
  amountLek?: number;
  detail: string;
  /**
   * NOT_FILED only: the request never reached easyPos (offline, outage), so
   * sending the same document again later is safe and will be done
   * automatically.
   */
  retryable?: boolean;
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
    const outcome = await cancelInvoice(
      input.settings,
      {
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
      },
      // A stored docId means an earlier attempt may have reached easyPos.
      existing ? { statusFirst: true } : undefined,
    );

    if (outcome.kind === 'complete') {
      return {
        state: 'FILED',
        docId,
        nslf: outcome.identifiers.iic,
        nivf: outcome.identifiers.fic,
        link: outcome.identifiers.link,
        qrCode: outcome.identifiers.qrCode,
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
      retryable: outcome.kind === 'not-registered',
    };
  } catch (e: any) {
    return {
      state: 'NOT_FILED',
      docId,
      detail: `Cancellation could not be sent: ${String(e?.message || e)}`,
    };
  }
}

/**
 * The slip of a filed cancellation or corrective invoice: what was taken
 * off, the refund, the document's own NIVF/NSLF and QR, and the invoice it
 * corrects. Nothing was printed for these, so the guest (and the till's
 * paper trail) had no fiscal receipt for the reversal. Best-effort: a
 * printer problem never undoes the filing. Kind `CORRECTION`, so it never
 * reads as a sale (`ensureSettledSaleFromPrintJob` takes PAYMENT only).
 */
/** The lekë a filed corrective or cancellation took back (negative). */
export function correctionLekTotal(
  filed: Pick<FiledCancellation, 'amountLek'>,
  payment: { metaJson?: unknown } | null | undefined,
): number | undefined {
  if (Number.isFinite(Number(filed.amountLek)) && filed.amountLek != null) {
    return roundMoney(-Math.abs(Number(filed.amountLek)));
  }
  const original = Number((payment?.metaJson as any)?.fiscalTotalLek);
  return Number.isFinite(original) && original > 0
    ? roundMoney(-original)
    : undefined;
}

export async function printCorrectionSlip(
  correctionId: number,
  filed: FiledCancellation,
): Promise<boolean> {
  try {
    const correction: any = await prisma.saleCorrection.findUnique({
      where: { id: correctionId },
    } as any);
    if (!correction) return false;
    const order: any = await prisma.order.findUnique({
      where: { id: Number(correction.orderId) },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    } as any);
    const payment = Array.isArray(order?.payments) ? order.payments[0] : null;
    const struck = Array.isArray(correction.itemsJson)
      ? (correction.itemsJson as any[])
      : [];
    const refund = Math.max(0, -roundMoney(num(correction.amountDelta)));
    const settings: any = await coreServices.readSettings();
    const { fireDispatchTicket } = await import('./printDispatcher');
    fireDispatchTicket(
      {
        area: String(order?.area || ''),
        tableLabel: String(order?.tableLabel || ''),
        covers: null,
        // Positive here; the slip prints them negative (`kind: CORRECTION`).
        items: struck.map((l) => ({
          name: String(l?.name || 'Item'),
          qty: num(l?.qty) || 1,
          unitPrice: num(l?.unitPrice),
          vatRate: l?.vatRate,
        })),
        note: String(correction.reason || '') || null,
        meta: {
          kind: 'CORRECTION',
          correctionKind: String(correction.kind || ''),
          correctsNslf:
            String(correction.originalNslf || payment?.fiscalNslf || '') ||
            undefined,
          method: String(payment?.method || ''),
          totalAfter: refund,
          vatEnabled: order?.vatEnabled === true,
          paidAt: new Date().toISOString(),
          fiscalEnabled: true,
          fiscalStatus: 'accepted',
          fiscalNslf: filed.nslf,
          fiscalNivf: filed.nivf,
          fiscalLink: filed.link,
          fiscalQrCode: filed.qrCode,
          // The lekë taken back, as filed: the corrective's own amount, or
          // all of what the cancelled invoice declared.
          fiscalTotalLek: correctionLekTotal(filed, payment),
        },
      } as any,
      settings,
      { persistRetryOnTransientFailure: true },
    );
    return true;
  } catch (e) {
    console.warn('[sale-correction] slip not printed:', e);
    return false;
  }
}

async function stampFiledCorrection(
  correctionId: number,
  filed: FiledCancellation,
): Promise<void> {
  void printCorrectionSlip(correctionId, filed);
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

/** Menu SKUs sold by weight. A lookup failure only costs the KGM unit. */
async function weighedSkus(skus: string[]): Promise<Set<string>> {
  try {
    const rows = (await prisma.menuItem.findMany({
      where: { sku: { in: skus.filter(Boolean) }, isKg: true } as any,
      select: { sku: true },
    })) as Array<{ sku: string }>;
    return new Set(rows.map((m) => m.sku));
  } catch {
    return new Set();
  }
}

async function fileCorrective(input: {
  settings: any;
  orderId: number;
  correctionId: number;
  originalDocId: string;
  iic: string;
  eic?: string;
  issueDateTime?: string;
  /** The lines being taken off the sale. */
  struck: Array<{
    sku?: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
  }>;
  /** The service charge that went with the struck lines. */
  serviceCharge?: number;
  /** Change to each VAT band, so the bands net out like the sale. */
  bandChange?: Partial<Record<string, number>>;
  /** The planned change to the sale total (negative). */
  amountDelta: number;
  method: string;
}): Promise<FiledCancellation> {
  const key = CORRECTIVE_DOC_KEY(input.orderId, input.correctionId);
  const existing = await readDocId(key);
  const docId = existing || newDocId('invoice');
  if (!existing) {
    await writeDocId(key, docId).catch(() => undefined);
  }

  try {
    const struck = input.struck.filter(
      (it) => Number.isFinite(it.qty) && it.qty > 0,
    );
    if (struck.length === 0) {
      return {
        state: 'NOT_FILED',
        docId,
        detail: 'Corrective invoice has no struck lines to file.',
      };
    }
    // The difference, not a restatement: filing the remaining lines next to
    // the original declared both (2,300 + 1,800 for a 1,800 sale). Weighed
    // lines keep the KGM unit the original was filed in, and the refund is
    // what the guest paid for them, discount and service charge included.
    const kgSkus = await weighedSkus(struck.map((it) => String(it.sku || '')));
    const { articles, amount } = buildCorrectionDifferenceLines(
      struck.map((it) => ({
        ...it,
        soldByKg: kgSkus.has(String(it.sku || '')),
      })),
      input.settings,
      {
        serviceCharge: input.serviceCharge,
        refund: Math.max(0, -roundMoney(input.amountDelta)),
        bandChange: input.bandChange,
      },
    );
    if (Math.abs(roundMoney(amount - input.amountDelta)) >= 0.01) {
      // The builder balances to the refund, so this is a guard only.
      return {
        state: 'NOT_FILED',
        docId,
        detail: `Corrective not filed automatically: the struck lines total ${amount.toFixed(2)} but the sale changes by ${input.amountDelta.toFixed(2)}. File it in easyPos.`,
      };
    }
    const method = mapPaymentMethod(input.method || 'CASH');
    // In lekë, like the invoice it corrects (`invoiceInLek`): a euro venue
    // used to file a corrective's euro amounts as lekë.
    const lek = invoiceInLek(articles, undefined, input.settings);
    const outcome = await registerCorrectiveInvoice(
      input.settings,
      {
        docId,
        articles: lek.articles,
        payment: [{ type: method as any, amount: lek.amount }],
        original: {
          iic: input.iic,
          eic: input.eic,
          issueDateTime: input.issueDateTime,
        },
      },
      // A stored docId means an earlier attempt may have reached easyPos.
      existing ? { statusFirst: true } : undefined,
    );
    if (outcome.kind === 'complete') {
      return {
        state: 'FILED',
        docId,
        nslf: outcome.identifiers.iic,
        nivf: outcome.identifiers.fic,
        link: outcome.identifiers.link,
        qrCode: outcome.identifiers.qrCode,
        amountLek: lek.amount,
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
      retryable: outcome.kind === 'not-registered',
    };
  } catch (e: any) {
    return {
      state: 'NOT_FILED',
      docId,
      detail: `Corrective could not be sent: ${String(e?.message || e)}`,
    };
  }
}

/**
 * The EIC of the invoice being reversed. A P10 cancellation or P9 corrective
 * of an electronic invoice must reference it.
 *
 * Sales settled before the ledger stored `Payment.fiscalEic` only have it on
 * their fiscal claim, which was written when the invoice was filed, so fall
 * back to that rather than filing the reversal without it.
 */
async function resolveOriginalEic(
  payment: any,
  idempotencyKey: string,
): Promise<string | undefined> {
  const stored = String(payment?.fiscalEic || '').trim();
  if (stored) return stored;
  if (!idempotencyKey) return undefined;
  try {
    const claim = await readFiscalClaim(
      docIdFromKey(idempotencyKey, 'invoice'),
    );
    return String(claim?.result?.eic || '').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * How the sale's service charge was worked out. Recorded on the payment
 * since this was needed; for older sales, the venue's current setting when
 * it reproduces the amount charged. Null reads as a percentage.
 */
function serviceChargeModeOf(
  payment: any,
  settings: any,
  amount?: number,
): 'PERCENT' | 'AMOUNT' | null {
  const recorded = String(paymentMeta(payment).serviceChargeMode || '');
  if (recorded === 'PERCENT' || recorded === 'AMOUNT') return recorded;
  const current = settings?.preferences?.serviceCharge;
  if (
    current?.mode === 'AMOUNT' &&
    Math.abs(num(current.value) - num(amount)) < 0.01
  ) {
    return 'AMOUNT';
  }
  return null;
}

/**
 * True when a corrective invoice has already struck part of the invoice
 * `iic` (filed, or queued to be).
 */
async function hasCorrectiveAgainst(
  orderId: number,
  iic: string,
  corrections: any[] | undefined,
): Promise<boolean> {
  const filed = (Array.isArray(corrections) ? corrections : []).some(
    (c) =>
      String(c?.kind) === 'CORRECTIVE' &&
      (String(c?.originalNslf || '').trim() === iic ||
        Boolean(String(c?.correctionNslf || '').trim())),
  );
  if (filed) return true;
  const queued = (await prisma.syncState
    .findMany({
      where: { key: { startsWith: `${CORRECTION_RETRY_PREFIX}${orderId}:` } },
    })
    .catch(() => [])) as any[];
  return queued.some((row) => {
    try {
      const raw = row?.valueJson;
      const q = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return q?.kind === 'CORRECTIVE';
    } catch {
      return false;
    }
  });
}

/** Claim states meaning the tax service holds an invoice for the sale. */
const FILED_CLAIM_STATES = new Set<FiscalClaimRecord['state']>([
  'REGISTERED',
  'CORRECTION_REQUIRED',
  'CORRECTED',
]);

/**
 * The claim currently carrying this sale's invoice.
 *
 * Normally the claim keyed by the payment's own key. A correction that
 * restated an unsent invoice leaves that claim ABANDONED and points it at the
 * replacement, so follow the chain.
 */
async function currentClaimForSale(
  saleKey: string,
): Promise<{ key: string; record: FiscalClaimRecord } | null> {
  let key: string;
  try {
    key = docIdFromKey(saleKey, 'invoice');
  } catch {
    return null;
  }
  for (let hop = 0; hop < 8; hop++) {
    const record = await readFiscalClaim(key);
    if (!record) return null;
    if (record.state === 'ABANDONED' && record.replacedBy) {
      key = record.replacedBy;
      continue;
    }
    return { key, record };
  }
  return null;
}

export interface UnsentInvoiceOutcome {
  /**
   * `WITHDRAWN` — the sale was cancelled before its invoice was sent; it will
   *   never be sent, and nothing needs filing.
   * `RESTATED` — a partial correction replaced the unsent invoice with one for
   *   the remaining lines, which the host sends automatically.
   * `SENT` — it went out while the correction waited; treat it as filed.
   * `UNKNOWN` — it was interrupted mid-send; a person must check easyPos.
   * `KEPT` — the restated invoice could not be built; the original still
   *   goes out and needs a corrective afterwards.
   */
  state: 'WITHDRAWN' | 'RESTATED' | 'SENT' | 'UNKNOWN' | 'KEPT';
  docId: string;
  detail: string;
  iic?: string;
  eic?: string;
}

/**
 * Reverse a sale whose invoice has not reached the tax service yet.
 *
 * Without this, an admin cancel of a sale taken during an outage looked at
 * `Payment.fiscalNslf` (empty until the invoice is sent), concluded the sale
 * was never fiscalized, and left the queued invoice in place — so the host
 * later filed the full original invoice for a cancelled sale, with nothing
 * to cancel it. A partial correction likewise let the original amounts go
 * out.
 *
 * Runs under the claim lock the transmit loop also holds, so the invoice is
 * either still unsent here (and is withdrawn or restated) or already sent
 * (and is reversed like any filed invoice). It cannot be both.
 */
async function reverseUnsentInvoice(input: {
  settings: any;
  claimKey: string;
  saleKey: string;
  orderId: number;
  area: string;
  tableLabel: string;
  cancelsSale: boolean;
  reason: string;
  remaining: Array<{
    sku: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
  }>;
  nextTotal: number;
  /** The sale's service charge and discount, carried over whole. */
  serviceChargeAmount: number;
  discountAmount: number;
  method: string;
}): Promise<UnsentInvoiceOutcome | null> {
  return withFiscalClaimLock(input.claimKey, async () => {
    const record = await readFiscalClaim(input.claimKey);
    if (!record) return null;

    if (FILED_CLAIM_STATES.has(record.state)) {
      return {
        state: 'SENT',
        docId: input.claimKey,
        detail: 'The invoice was sent before the correction was applied.',
        iic: String(record.result?.nslf || '').trim() || undefined,
        eic: String(record.result?.eic || '').trim() || undefined,
      };
    }

    const note = `Sale #${input.orderId} was ${input.cancelsSale ? 'cancelled' : 'corrected'} (${input.reason}) while it is not known whether this invoice was filed. If easyPos has it, ${input.cancelsSale ? 'cancel it' : 'file a corrective invoice'} there.`;
    if (isDeadPendingClaim(record)) {
      await markDeadPendingUnknownUnlocked(input.claimKey, note);
      return { state: 'UNKNOWN', docId: input.claimKey, detail: note };
    }
    if (record.state === 'UNKNOWN') {
      await annotateFiscalClaimUnlocked(input.claimKey, {
        lastError: `${record.lastError ? `${record.lastError} · ` : ''}${note}`,
      });
      return { state: 'UNKNOWN', docId: input.claimKey, detail: note };
    }
    if (record.state !== 'DEFERRED' && record.state !== 'FAILED') return null;

    // An earlier send of this invoice was never confirmed. Ask easyPos
    // before treating it as unsent: withdrawing one it already holds would
    // leave a filed invoice for a cancelled sale.
    if (record.checkStatusFirst) {
      const probe = await checkFiscalDocStatus(
        input.settings,
        input.claimKey,
        record.draft,
      );
      if (probe.kind === 'filed') {
        const r = probe.result;
        await settleFiscalClaimRegistered(input.claimKey, record.attemptId, {
          nslf: r.nslf || undefined,
          nivf: r.nivf || undefined,
          eic: r.eic || undefined,
          link: r.link || undefined,
          qrCode: r.qrCode || undefined,
          status: r.status,
        });
        // The sale keeps its codes for reprints. Loaded lazily: the
        // deferred loop imports this module the same way.
        await import('./fiscal/deferred')
          .then((m) => m.stampFiscalIdentifiersOnSale(input.saleKey, r))
          .catch(() => undefined);
        return {
          state: 'SENT',
          docId: input.claimKey,
          detail:
            'easyPos already had this invoice, so it is reversed like any filed invoice.',
          iic: String(r.nslf || '').trim() || undefined,
          eic: String(r.eic || '').trim() || undefined,
        };
      }
      if (probe.kind === 'unknown') {
        const detail = `${note} ${probe.message}`;
        await parkUnconfirmedClaimUnlocked(input.claimKey, detail);
        return { state: 'UNKNOWN', docId: input.claimKey, detail };
      }
    }
    // Reached only when nothing earlier may have been filed, or easyPos
    // just said it has never seen this docId.
    const statusConfirmedAbsent = record.checkStatusFirst === true;

    if (input.cancelsSale) {
      await abandonUnsentFiscalClaimUnlocked(
        input.claimKey,
        `Sale #${input.orderId} cancelled before its invoice was sent: ${input.reason}`,
        { statusConfirmedAbsent },
      );
      return {
        state: 'WITHDRAWN',
        docId: input.claimKey,
        detail:
          'The sale was cancelled before its invoice reached the tax service, so the invoice was withdrawn and will not be sent.',
      };
    }

    const remaining = input.remaining.filter(
      (it) => Number.isFinite(it.qty) && it.qty > 0,
    );
    const docId = newDocId('invoice');
    let draft: unknown;
    try {
      if (remaining.length === 0) {
        throw new Error('no remaining lines');
      }
      draft = JSON.parse(
        JSON.stringify(
          buildEasyPosInvoiceDraft(
            {
              area: input.area,
              tableLabel: input.tableLabel,
              covers: null,
              items: remaining.map((it) => ({
                sku: it.sku,
                name: it.name,
                qty: it.qty,
                unitPrice: it.unitPrice,
                vatRate: it.vatRate,
              })),
              note: null,
              meta: {
                kind: 'PAYMENT',
                method: input.method,
                totalAfter: roundMoney(input.nextTotal),
                // Named on the restated invoice as they were on the one
                // it replaces, not folded into a balancing line.
                serviceChargeAmount: roundMoney(input.serviceChargeAmount),
                discountAmount: Math.min(
                  roundMoney(input.discountAmount),
                  roundMoney(
                    remaining.reduce((t, it) => t + it.qty * it.unitPrice, 0) +
                      input.serviceChargeAmount,
                  ),
                ),
              },
            } as any,
            input.settings,
            { docId },
          ),
        ),
      );
    } catch (e: any) {
      const detail = `The corrected invoice could not be prepared (${String(
        e?.message || e,
      )}), so the original invoice will still be sent. File a corrective invoice in easyPos once it is.`;
      await annotateFiscalClaimUnlocked(input.claimKey, {
        lastError: `${record.lastError ? `${record.lastError} · ` : ''}${detail}`,
      });
      return { state: 'KEPT', docId: input.claimKey, detail };
    }

    await createDeferredFiscalClaim(docId, {
      context: {
        ...(record.context || {}),
        total: roundMoney(input.nextTotal),
        saleKey: input.saleKey,
      },
      draft,
      reason: `Restated after correction of sale #${input.orderId}: ${input.reason}`,
      createdAt: record.createdAt,
    });
    await abandonUnsentFiscalClaimUnlocked(
      input.claimKey,
      `Replaced by ${docId} after sale #${input.orderId} was corrected: ${input.reason}`,
      { replacedBy: docId, statusConfirmedAbsent },
    );
    return {
      state: 'RESTATED',
      docId,
      detail:
        'The invoice had not been sent yet, so it was replaced by one for the remaining items. It will be sent automatically.',
    };
  });
}

export interface ApplySaleCorrectionInput {
  orderId: number;
  kind: SaleCorrectionKind;
  itemIds?: readonly number[] | null;
  reason: string;
  actorUserId?: number | null;
  approvedById?: number | null;
  /**
   * Shops: put the struck lines back on the shelf count. A voided shop
   * ticket (e.g. printed by mistake) never sold its goods.
   */
  restockStore?: boolean;
  /**
   * The request's key. A repeat (a double tap, a retried request) gets the
   * first one's result instead of a second correction.
   */
  idempotencyKey?: string | null;
}

/** Where a correction request's key and its result are kept. */
export const CORRECTION_KEY_PREFIX = 'fiscal:correction-key:';

/** Raised inside the correction transaction when the lines moved under it. */
class CorrectionRaceError extends Error {
  constructor(readonly error: SaleCorrectionError) {
    super(error);
  }
}

/**
 * Reverse a settled sale, once.
 *
 * QA filed two corrective invoices (−4.00 twice) for one line from two
 * identical requests sent together: each read the line as live, each
 * created its own correction, and each got its own docId. Now
 *   - corrections of one sale run one at a time (`withFiscalClaimLock`),
 *     and the sale is read inside that turn;
 *   - the lines are struck, and the sale voided, only if they are still
 *     live, in the same transaction that records the correction, so a line
 *     already corrected (or being corrected) is refused, never filed twice;
 *   - the request's key is claimed in that transaction too, and a repeat
 *     of it answers with the first result.
 */
export async function applySaleCorrection(
  input: ApplySaleCorrectionInput,
): Promise<ApplyCorrectionResult> {
  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return { ok: false, error: 'not-found' };
  }
  const requestKey = String(input.idempotencyKey || '')
    .trim()
    .slice(0, 200);
  return withFiscalClaimLock(`sale-correction:${orderId}`, async () => {
    if (requestKey) {
      const prior = await readCorrectionKey(requestKey);
      if (prior) return prior;
    }
    const result = await applySaleCorrectionNow(input, requestKey);
    if (requestKey && result.ok) {
      await saveCorrectionKey(requestKey, orderId, result).catch(
        () => undefined,
      );
    }
    return result;
  });
}

async function readCorrectionKey(
  key: string,
): Promise<ApplyCorrectionResult | null> {
  const row = await prisma.syncState
    .findUnique({ where: { key: `${CORRECTION_KEY_PREFIX}${key}` } })
    .catch(() => null);
  const value = (row as any)?.valueJson;
  if (!value || typeof value !== 'object') return null;
  if (value.result && typeof value.result === 'object') {
    return value.result as ApplyCorrectionResult;
  }
  // Claimed, but the first request ended before its result was stored (a
  // crash mid-filing): the correction exists, so answer with it.
  const correctionId = Number(value.correctionId);
  return Number.isFinite(correctionId) && correctionId > 0
    ? {
        ok: true,
        correctionId,
        kind: value.kind as SaleCorrectionKind,
        amountDelta: num(value.amountDelta),
        needsFiling: true,
      }
    : null;
}

async function saveCorrectionKey(
  key: string,
  orderId: number,
  result: ApplyCorrectionResult,
): Promise<void> {
  const fullKey = `${CORRECTION_KEY_PREFIX}${key}`;
  const valueJson = {
    orderId,
    ...(result.ok
      ? {
          correctionId: result.correctionId,
          kind: result.kind,
          amountDelta: result.amountDelta,
        }
      : {}),
    result,
    savedAt: new Date().toISOString(),
  } as any;
  await prisma.syncState.upsert({
    where: { key: fullKey },
    create: { key: fullKey, valueJson },
    update: { valueJson },
  });
}

async function applySaleCorrectionNow(
  input: ApplySaleCorrectionInput,
  requestKey: string,
): Promise<ApplyCorrectionResult> {
  const orderId = Number(input.orderId);

  const order = await prisma.order
    .findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        corrections: {
          select: {
            id: true,
            kind: true,
            originalNslf: true,
            correctionNslf: true,
          },
        },
      } as any,
    })
    .catch(() => null);
  if (!order) return { ok: false, error: 'not-found' };

  const settings: any = await coreServices.readSettings().catch(() => ({}));
  const latestPayment = Array.isArray((order as any).payments)
    ? (order as any).payments[0]
    : null;
  const planned = planSaleCorrection(
    {
      status: (order as any).status,
      total: num((order as any).total),
      vatEnabled: (order as any).vatEnabled === true,
      serviceChargeAmount: num((order as any).serviceChargeAmount),
      serviceChargeMode: serviceChargeModeOf(
        latestPayment,
        settings,
        num((order as any).serviceChargeAmount),
      ),
      discountAmount: num((order as any).discountAmount),
      discountType: (order as any).discountType ?? null,
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

  const payment = latestPayment;
  const now = new Date();

  let correctionId: number;
  try {
    correctionId = await prisma.$transaction(async (tx: any) => {
      if (plan.struckItemIds.length > 0) {
        // Only lines still live: one corrected (or being corrected) by
        // another request is not struck, or filed, a second time.
        const struck = await tx.orderItem.updateMany({
          where: { id: { in: plan.struckItemIds }, orderId, voidedAt: null },
          data: { voidedAt: now },
        });
        if (Number(struck?.count) !== plan.struckItemIds.length) {
          throw new CorrectionRaceError('line-already-void');
        }
        if (input.restockStore) {
          const struck = new Set(plan.struckItemIds);
          await restockMenuStockForLines(
            tx,
            ((order as any).items || [])
              .filter((it: any) => struck.has(Number(it.id)))
              .map((it: any) => ({
                sku: String(it.sku || ''),
                qty: num(it.qty),
              })),
          );
        }
      }
      if (plan.cancelsSale) {
        // The filed figures are left alone: VOID is what excludes the sale, and
        // an audit needs to still show what the guest was charged.
        const voided = await tx.order.updateMany({
          where: { id: orderId, status: { not: 'VOID' } },
          data: { status: 'VOID', voidedAt: now },
        });
        if (Number(voided?.count) !== 1) {
          throw new CorrectionRaceError('already-void');
        }
      } else {
        await tx.order.update({
          where: { id: orderId },
          data: {
            subtotal: plan.nextSubtotal,
            vatAmount: plan.nextVat,
            total: plan.nextTotal,
            serviceChargeAmount: plan.nextServiceCharge,
            discountAmount: plan.nextDiscount,
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
      if (requestKey) {
        // Claimed with the correction: a crash before the result is stored
        // still answers a repeat with this correction, not a new one.
        await tx.syncState.create({
          data: {
            key: `${CORRECTION_KEY_PREFIX}${requestKey}`,
            valueJson: {
              orderId,
              correctionId: Number(created.id),
              kind: plan.kind,
              amountDelta: plan.amountDelta,
            } as any,
          },
        });
      }
      return Number(created.id);
    });
  } catch (e) {
    if (e instanceof CorrectionRaceError) return { ok: false, error: e.error };
    throw e;
  }

  const docId = String(payment?.idempotencyKey || '').trim();
  let iic = String(payment?.fiscalNslf || '').trim();
  let claimEic: string | undefined;
  let unsent: UnsentInvoiceOutcome | null = null;

  // The payment row only learns its NSLF once the invoice is sent. Until
  // then — and when a filed invoice's identifiers never reached the row —
  // the claim is the truth about whether the tax service holds an invoice.
  if (!iic && docId) {
    const current = await currentClaimForSale(docId).catch(() => null);
    if (current && FILED_CLAIM_STATES.has(current.record.state)) {
      iic = String(current.record.result?.nslf || '').trim();
      claimEic = String(current.record.result?.eic || '').trim() || undefined;
    } else if (current) {
      const struckIds = new Set(plan.struckItemIds);
      try {
        unsent = await reverseUnsentInvoice({
          settings,
          claimKey: current.key,
          saleKey: docId,
          orderId,
          area: String((order as any).area || ''),
          tableLabel: String((order as any).tableLabel || ''),
          cancelsSale: plan.cancelsSale,
          reason: plan.reason,
          remaining: ((order as any).items || [])
            .filter(
              (it: any) => !struckIds.has(Number(it.id)) && it.voidedAt == null,
            )
            .map((it: any) => ({
              sku: String(it.sku || ''),
              name: String(it.name || 'Item'),
              qty: num(it.qty),
              unitPrice: num(it.unitPrice),
              vatRate: num(it.vatRate),
            })),
          nextTotal: plan.nextTotal,
          serviceChargeAmount: plan.nextServiceCharge,
          discountAmount: plan.nextDiscount,
          method: String(payment?.method || 'CASH'),
        });
      } catch (e: any) {
        unsent = {
          state: 'UNKNOWN',
          docId: current.key,
          detail: `The unsent invoice could not be updated for this correction (${String(
            e?.message || e,
          )}). Check docId ${current.key} in Settings › Fiskalizimi.`,
        };
      }
      if (unsent?.state === 'SENT') {
        iic = String(unsent.iic || '').trim();
        claimEic = unsent.eic;
      }
    }
  }

  const wasFiscalized = Boolean(
    iic || String(payment?.fiscalNivf || '').trim(),
  );
  // Filed on the easyPos test service while the till is now live: there is
  // nothing on the live service to cancel, and sending one would be refused
  // or, worse, mistaken for a real reversal.
  const saleClaim = docId
    ? await currentClaimForSale(docId).catch(() => null)
    : null;
  const filedOnTestService = isLeftoverTestWork(
    saleClaim?.record.context?.environment,
    fiscalConfig(settings).environment,
  );
  const originalEic =
    (await resolveOriginalEic(payment, docId)) || claimEic || undefined;
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
  // easyPos cancels the whole original invoice. After a corrective has
  // already struck part of it, that reverses those lines a second time, so
  // the rest of the sale is struck by another corrective instead.
  const cancelAsCorrective =
    plan.cancelsSale &&
    Boolean(iic) &&
    (await hasCorrectiveAgainst(orderId, iic, (order as any).corrections));
  // What the invoice files per VAT band before and after, the way the
  // original was built. Filing the difference keeps each band right when a
  // fixed discount or service charge was spread over several of them.
  let bandChange: Partial<Record<string, number>> | undefined;
  try {
    const struckIds = new Set(plan.struckItemIds);
    const asLine = (it: any) => ({
      sku: String(it.sku || ''),
      name: String(it.name || 'Item'),
      qty: num(it.qty),
      unitPrice: num(it.unitPrice),
      vatRate: num(it.vatRate),
    });
    const live = ((order as any).items || []).filter(
      (it: any) => it.voidedAt == null,
    );
    const before = invoiceBandTotals(
      {
        items: live.map(asLine),
        serviceChargeAmount: num((order as any).serviceChargeAmount),
        discountAmount: num((order as any).discountAmount),
        total: num((order as any).total),
      },
      settings,
    );
    const after = plan.cancelsSale
      ? {}
      : invoiceBandTotals(
          {
            items: live
              .filter((it: any) => !struckIds.has(Number(it.id)))
              .map(asLine),
            serviceChargeAmount: plan.nextServiceCharge,
            discountAmount: plan.nextDiscount,
            total: plan.nextTotal,
          },
          settings,
        );
    bandChange = bandChangeBetween(before, after);
  } catch {
    // Unknown VAT configuration: the document is balanced as a whole.
    bandChange = undefined;
  }
  const struckLines = (): QueuedCorrection['struck'] => {
    const struck = new Set(plan.struckItemIds);
    return ((order as any).items || [])
      .filter((it: any) => struck.has(Number(it.id)))
      .map((it: any) => ({
        sku: String(it.sku || ''),
        name: String(it.name || 'Item'),
        qty: num(it.qty),
        unitPrice: num(it.unitPrice),
        vatRate: num(it.vatRate),
      }));
  };
  if (wasFiscalized && docId && filedOnTestService) {
    await notifyAdminsAndActor({
      message:
        `Sale #${orderId} reversed${where ? ` (${where})` : ''}: ${plan.reason}` +
        ` · ${plan.amountDelta} · Its invoice was filed on the easyPos test service, so nothing is filed with the tax authority.`,
      actorUserId: Number(input.actorUserId) || undefined,
      type: 'SECURITY',
    }).catch(() => undefined);
  } else if (wasFiscalized && docId) {
    if (
      plan.cancelsSale &&
      !cancelAsCorrective &&
      iic &&
      isFiscalEnabled(settings)
    ) {
      cancellation = await fileCancellation({
        settings,
        orderId,
        originalDocId: docId,
        iic,
        eic: originalEic,
        issueDateTime: iso(payment?.paidAt) || undefined,
      });
    } else if (iic && isFiscalEnabled(settings)) {
      corrective = await fileCorrective({
        settings,
        orderId,
        correctionId,
        originalDocId: docId,
        iic,
        eic: originalEic,
        issueDateTime: iso(payment?.paidAt) || undefined,
        struck: struckLines(),
        serviceCharge: plan.struckServiceCharge,
        bandChange,
        amountDelta: plan.amountDelta,
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
      const attempted = cancellation || corrective;
      const queued =
        attempted?.state === 'NOT_FILED' && attempted.retryable === true;
      if (queued) {
        await queueCorrectionRetry({
          orderId,
          correctionId,
          originalDocId: docId,
          kind: cancellation ? 'CANCEL' : 'CORRECTIVE',
          iic: iic!,
          eic: originalEic,
          issueDateTime: iso(payment?.paidAt) || undefined,
          struck: cancellation ? [] : struckLines(),
          serviceCharge: cancellation ? undefined : plan.struckServiceCharge,
          bandChange: cancellation ? undefined : bandChange,
          environment: fiscalConfig(settings).environment,
          amountDelta: plan.amountDelta,
          method: String(payment?.method || 'CASH'),
        }).catch(() => undefined);
      }
      needsFiling = await flagFiscalCorrectionRequired({
        idempotencyKey: docId,
        queued,
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
          eic: originalEic,
        },
      }).catch(() => false);
    }
  } else if (unsent) {
    // The invoice had not reached the tax service yet. Withdrawn or restated
    // needs nothing from anyone; the other outcomes are on the review list.
    needsFiling = unsent.state !== 'WITHDRAWN' && unsent.state !== 'RESTATED';
    await notifyAdminsAndActor({
      message:
        `Sale #${orderId} reversed${where ? ` (${where})` : ''}: ${plan.reason}` +
        ` · ${plan.amountDelta} · Fiskalizimi: ${unsent.detail} · docId ${unsent.docId}`,
      actorUserId: Number(input.actorUserId) || undefined,
      type: 'SECURITY',
    }).catch(() => undefined);
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

/**
 * Cancellations and correctives that could not reach easyPos.
 *
 * A void during an outage used to be filed once, fail, and wait on the
 * review list for an admin to file it by hand in easyPos, so the tax
 * service kept the full sale. They are now resent by the fiskalizimi loop
 * under the docId persisted before the first attempt, which the status
 * check makes safe to repeat.
 */
const CORRECTION_RETRY_PREFIX = 'fiscal:correction-retry:';
const CORRECTION_RETRY_MAX_MS = 5 * 60_000;

interface QueuedCorrection {
  orderId: number;
  correctionId: number;
  originalDocId: string;
  kind: 'CANCEL' | 'CORRECTIVE';
  iic: string;
  eic?: string;
  issueDateTime?: string;
  struck: Array<{
    sku?: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
  }>;
  /** Absent on corrections queued before service charge was struck. */
  serviceCharge?: number;
  bandChange?: Partial<Record<string, number>>;
  /** The easyPos service the original invoice was filed on. */
  environment?: 'dev' | 'prod' | 'local';
  amountDelta: number;
  method: string;
  attempts?: number;
  nextAttemptAt?: string;
  createdAt?: string;
}

async function queueCorrectionRetry(input: QueuedCorrection): Promise<void> {
  const key = `${CORRECTION_RETRY_PREFIX}${input.orderId}:${input.correctionId}`;
  const valueJson = {
    ...input,
    attempts: 1,
    createdAt: new Date().toISOString(),
    nextAttemptAt: new Date(Date.now() + 15_000).toISOString(),
  } as any;
  await prisma.syncState.upsert({
    where: { key },
    create: { key, valueJson },
    update: { valueJson },
  });
}

let correctionRetryRunning = false;

/** One pass over queued corrections. Called from the fiskalizimi loop. */
export async function retryQueuedFiscalCorrections(
  settings: any,
  now = Date.now(),
): Promise<{ attempted: number; filed: number }> {
  if (correctionRetryRunning || !isFiscalEnabled(settings)) {
    return { attempted: 0, filed: 0 };
  }
  correctionRetryRunning = true;
  let attempted = 0;
  let filed = 0;
  try {
    const rows = (await prisma.syncState
      .findMany({ where: { key: { startsWith: CORRECTION_RETRY_PREFIX } } })
      .catch(() => [])) as any[];
    // After one finds easyPos unreachable, the rest wait for the next pass
    // rather than each spending a full recovery budget finding the same.
    let unreachable = false;
    const environment = fiscalConfig(settings).environment;
    for (const row of rows) {
      if (unreachable) break;
      const raw = row.valueJson;
      let q: QueuedCorrection;
      try {
        q = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        continue;
      }
      if (!q) continue;
      // A reversal of a test-service sale has nothing to reverse on the
      // live service; one of a live sale waits for the live service.
      if (isLeftoverTestWork(q.environment, environment)) {
        await prisma.syncState
          .delete({ where: { key: row.key } })
          .catch(() => undefined);
        continue;
      }
      if (!sameFiscalEnvironment(q.environment, environment)) continue;
      if (Date.parse(String(q.nextAttemptAt || '')) > now) continue;
      attempted += 1;
      const result =
        q.kind === 'CANCEL'
          ? await fileCancellation({
              settings,
              orderId: q.orderId,
              originalDocId: q.originalDocId,
              iic: q.iic,
              eic: q.eic,
              issueDateTime: q.issueDateTime,
            })
          : await fileCorrective({
              settings,
              orderId: q.orderId,
              correctionId: q.correctionId,
              originalDocId: q.originalDocId,
              iic: q.iic,
              eic: q.eic,
              issueDateTime: q.issueDateTime,
              struck: q.struck,
              serviceCharge: q.serviceCharge,
              bandChange: q.bandChange,
              amountDelta: q.amountDelta,
              method: q.method,
            });

      if (result.state === 'NOT_FILED' && result.retryable) {
        unreachable = true;
        const attempts = (q.attempts || 1) + 1;
        const wait = Math.min(
          CORRECTION_RETRY_MAX_MS,
          15_000 * 2 ** Math.min(attempts, 6),
        );
        await prisma.syncState
          .update({
            where: { key: row.key },
            data: {
              valueJson: {
                ...q,
                attempts,
                nextAttemptAt: new Date(now + wait).toISOString(),
              } as any,
            },
          })
          .catch(() => undefined);
        continue;
      }

      await prisma.syncState
        .delete({ where: { key: row.key } })
        .catch(() => undefined);
      if (result.state === 'FILED') {
        filed += 1;
        await stampFiledCorrection(q.correctionId, result);
        await resolveFiscalClaim(q.originalDocId, 'corrected').catch(
          () => false,
        );
        await notifyAdminsAndActor({
          message: `Fiskalizimi: the queued ${q.kind === 'CANCEL' ? 'cancellation' : 'corrective invoice'} for sale #${q.orderId} was sent · ${result.detail}`,
          type: 'SECURITY',
        }).catch(() => undefined);
      } else {
        // Refused, or the outcome is unknown: that needs a person. The
        // review entry is still open; give it the latest reason.
        await annotateCorrectionReview(q.originalDocId, result.detail);
      }
    }
  } finally {
    correctionRetryRunning = false;
  }
  return { attempted, filed };
}

async function annotateCorrectionReview(
  docId: string,
  detail: string,
): Promise<void> {
  await withFiscalClaimLock(docId, () =>
    annotateFiscalClaimUnlocked(docId, { lastError: detail }),
  ).catch(() => undefined);
}
