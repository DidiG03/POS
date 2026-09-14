/**
 * Builders for each document type the API accepts.
 *
 * One builder per type rather than a single bag of optional fields,
 * because the types are not variations on a theme — an ORDER must have no
 * payment, a SUMMARY must have no articles, an EXPORT must have a foreign
 * buyer and a supply period. Expressing that as "pass whatever you have"
 * is how a SUMMARY ends up carrying articles and the tax service rejects
 * an invoice the till has already collected money for.
 *
 * Every builder validates before returning, so an invalid document cannot
 * reach the point of having a docId spent on it.
 */

import { roundMoney } from '@shared/pricing';
import {
  DEFAULT_CURRENCY,
  type CorrectiveInvoiceRef,
  type DocumentType,
  type ElectronicProcess,
  type InvoiceArticle,
  type InvoiceBuyer,
  type InvoiceCurrency,
  type InvoicePayment,
  type Rebate,
  type RegisterInvoiceRequest,
  type SummaryInvoiceRef,
  type SupplyPeriod,
} from './apiTypes';
import { assertValidDocId } from './docId';
import {
  assertValidRegisterInvoice,
  computeInvoiceTotal,
  normalizeNuis,
  TOTAL_TOLERANCE,
} from './validate';

export interface BaseInvoiceInput {
  /** Generated once and already persisted by the caller. */
  docId: string;
  operatorCode?: string;
  currency?: InvoiceCurrency;
  buyer?: InvoiceBuyer;
  invoiceRebate?: Rebate;
}

/** Drop undefined keys so a replay's body is byte-identical every time. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Normalise a buyer.
 *
 * NUIS is upper-cased here rather than at the validation boundary so the
 * value that goes on the wire is the normalised one — validating an
 * upper-cased copy and sending the original is a bug that only shows up
 * with lower-case input.
 */
export function normalizeBuyer(buyer?: InvoiceBuyer): InvoiceBuyer | undefined {
  if (!buyer) return undefined;
  const buyerID =
    buyer.buyerIDType === 'NUIS'
      ? normalizeNuis(buyer.buyerID)
      : String(buyer.buyerID || '').trim();
  return compact({
    ...buyer,
    buyerID,
    name: String(buyer.name || '').trim(),
    countryCode: buyer.countryCode
      ? String(buyer.countryCode).trim().toUpperCase()
      : undefined,
  });
}

/**
 * Build the `currency` block.
 *
 * ALL is the default and is omitted entirely — the API assumes it. Any
 * other currency must carry a rate against ALL, so a missing rate is an
 * error here rather than an invoice the tax service values at zero.
 */
export function buildCurrency(input: {
  code?: string;
  exRate?: number;
}): InvoiceCurrency | undefined {
  const code = String(input.code || '')
    .trim()
    .toUpperCase();
  if (!code || code === DEFAULT_CURRENCY) return undefined;
  const rate = Number(input.exRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(
      `Currency ${code} requires an exchange rate against ${DEFAULT_CURRENCY}. Set it in Admin → Fiskalizimi.`,
    );
  }
  return { code, exRate: rate };
}

function base(input: BaseInvoiceInput, documentType?: DocumentType) {
  return compact({
    docId: assertValidDocId(input.docId),
    ...(documentType && documentType !== 'NORMAL' ? { documentType } : {}),
    operatorCode: input.operatorCode?.trim() || undefined,
    currency: input.currency,
    buyer: normalizeBuyer(input.buyer),
    invoiceRebate: input.invoiceRebate,
  });
}

/* ------------------------------------------------------------------ *
 * NORMAL
 * ------------------------------------------------------------------ */

export interface NormalInvoiceInput extends BaseInvoiceInput {
  articles: InvoiceArticle[];
  payment: InvoicePayment[];
}

/**
 * A plain sale. `documentType` is omitted rather than set to `'NORMAL'`,
 * which is what the API expects and what its examples show.
 */
export function buildNormalInvoice(
  input: NormalInvoiceInput,
): RegisterInvoiceRequest {
  const request: RegisterInvoiceRequest = {
    ...base(input),
    articles: input.articles,
    payment: input.payment,
  };
  assertValidRegisterInvoice(request);
  return request;
}

/* ------------------------------------------------------------------ *
 * ORDER
 * ------------------------------------------------------------------ */

export interface OrderInvoiceInput extends BaseInvoiceInput {
  articles: InvoiceArticle[];
}

/**
 * An order: articles with no payment at all.
 *
 * `payment` is not set to `[]` — the key is absent, which is what makes
 * the API generate the document as an ORDER. An empty array is a payment
 * array that fails the total check.
 */
export function buildOrderInvoice(
  input: OrderInvoiceInput,
): RegisterInvoiceRequest {
  const request: RegisterInvoiceRequest = {
    ...base(input, 'ORDER'),
    articles: input.articles,
  };
  assertValidRegisterInvoice(request);
  return request;
}

/* ------------------------------------------------------------------ *
 * SUMMARY
 * ------------------------------------------------------------------ */

export interface SummaryInvoiceInput extends BaseInvoiceInput {
  /** IICs of the ORDER invoices being settled. */
  summaryInvoices: SummaryInvoiceRef[];
  /** Must equal the referenced ORDER total exactly. */
  total: number;
  payment: InvoicePayment[];
}

/**
 * A summary invoice settling previously issued ORDER documents.
 *
 * Carries no articles; the totals come from the referenced orders. The
 * stated total is checked against the payment array here, and the caller is
 * responsible for it matching the orders — see `assertSummaryMatchesOrders`.
 */
export function buildSummaryInvoice(
  input: SummaryInvoiceInput,
): RegisterInvoiceRequest {
  const request: RegisterInvoiceRequest = {
    ...base(input, 'SUMMARY'),
    summaryInvoices: input.summaryInvoices,
    total: roundMoney(input.total),
    payment: input.payment,
  };
  assertValidRegisterInvoice(request);
  return request;
}

/**
 * Confirm a SUMMARY's total against the orders it references.
 *
 * The API requires an exact match and rejects the document otherwise. This
 * is separate from the builder because it needs the order totals, which
 * only the caller can look up.
 */
export function assertSummaryMatchesOrders(input: {
  total: number;
  orderTotals: number[];
}): void {
  const orders = roundMoney(
    input.orderTotals.reduce((sum, n) => sum + (Number(n) || 0), 0),
  );
  const stated = roundMoney(input.total);
  if (Math.abs(roundMoney(stated - orders)) > TOTAL_TOLERANCE) {
    throw new Error(
      `A SUMMARY invoice must equal the ORDER invoices it settles: stated ${stated.toFixed(2)}, referenced orders total ${orders.toFixed(2)}.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * SELFISSUE
 * ------------------------------------------------------------------ */

export interface SelfIssueInvoiceInput extends BaseInvoiceInput {
  articles: InvoiceArticle[];
  payment: InvoicePayment[];
  selfIssueType: string;
  /** On a self-issued invoice the "buyer" block carries the supplier. */
  buyer: InvoiceBuyer;
  reverseCharge: boolean;
}

export function buildSelfIssueInvoice(
  input: SelfIssueInvoiceInput,
): RegisterInvoiceRequest {
  const request: RegisterInvoiceRequest = {
    ...base(input, 'SELFISSUE'),
    articles: input.articles,
    payment: input.payment,
    selfIssueType: String(input.selfIssueType || '').trim(),
    reverseCharge: input.reverseCharge === true,
  };
  assertValidRegisterInvoice(request);
  return request;
}

/* ------------------------------------------------------------------ *
 * EXPORT
 * ------------------------------------------------------------------ */

export interface ExportInvoiceInput extends BaseInvoiceInput {
  articles: InvoiceArticle[];
  payment: InvoicePayment[];
  /** Must be foreign. */
  buyer: InvoiceBuyer;
  supplyPeriod: SupplyPeriod;
}

/**
 * An export invoice. Every line is forced to the export band `J` — leaving
 * a domestic code on an export line is accepted by nobody and is the
 * easiest way to file an export as a taxable domestic sale.
 */
export function buildExportInvoice(
  input: ExportInvoiceInput,
): RegisterInvoiceRequest {
  const request: RegisterInvoiceRequest = {
    ...base(input, 'EXPORT'),
    articles: input.articles.map((article) => ({
      ...article,
      vatCode: 'J' as const,
    })),
    payment: input.payment,
    supplyPeriod: input.supplyPeriod,
  };
  assertValidRegisterInvoice(request);
  return request;
}

/* ------------------------------------------------------------------ *
 * ELECTRONIC (P1–P11)
 * ------------------------------------------------------------------ */

export interface ElectronicInvoiceInput extends BaseInvoiceInput {
  articles: InvoiceArticle[];
  payment: InvoicePayment[];
  selectedProcess: ElectronicProcess;
  /** Buyer is mandatory for an e-invoice. */
  buyer: InvoiceBuyer;
  /** P4 only: the amount already paid. */
  prepaidAmount?: number;
  /** P9 / P10 only: the invoice being corrected or cancelled. */
  correctiveInvoice?: CorrectiveInvoiceRef;
  documentType?: DocumentType;
}

/**
 * An electronic invoice.
 *
 * The completion contract for these is `fic` AND `eic` — see
 * `targetForInvoice`, which reads `isEinvoice` off the request so the
 * caller cannot forget to ask for the stricter check.
 */
export function buildElectronicInvoice(
  input: ElectronicInvoiceInput,
): RegisterInvoiceRequest {
  const request: RegisterInvoiceRequest = compact({
    ...base(input, input.documentType),
    articles: input.articles,
    payment: input.payment,
    isEinvoice: true,
    selectedProcess: input.selectedProcess,
    prepaidAmount:
      input.selectedProcess === 'P4'
        ? roundMoney(input.prepaidAmount ?? 0)
        : undefined,
    correctiveInvoice: input.correctiveInvoice,
  });
  assertValidRegisterInvoice(request);
  return request;
}

/* ------------------------------------------------------------------ *
 * CORRECTIVE (partial — remaining lines, original IIC)
 * ------------------------------------------------------------------ */

export interface CorrectiveInvoiceInput extends BaseInvoiceInput {
  articles: InvoiceArticle[];
  payment: InvoicePayment[];
  original: {
    iic: string;
    issueDateTime?: string;
    eic?: string;
  };
  /** Required only when the original was an electronic invoice (P9). */
  buyer?: InvoiceBuyer;
}

/**
 * A restated invoice for the lines that survive a partial void.
 *
 * Cash / non-electronic originals are a NORMAL register with
 * `correctiveInvoice.type = CORRECTIVE`. Electronic originals are P9 and
 * need the buyer from the original e-invoice — without that we refuse
 * rather than file a P9 CIS will reject.
 */
export function buildCorrectiveInvoice(
  input: CorrectiveInvoiceInput,
): RegisterInvoiceRequest {
  const iicRef = String(input.original?.iic || '').trim();
  if (!iicRef) {
    throw new Error(
      'Cannot file a corrective invoice without the original IIC (correctiveInvoice.iicRef).',
    );
  }
  const ref: CorrectiveInvoiceRef = {
    iicRef,
    type: 'CORRECTIVE',
    ...(input.original.issueDateTime
      ? { issueDateTimeRef: input.original.issueDateTime }
      : {}),
  };
  const electronic = Boolean(String(input.original.eic || '').trim());
  if (electronic) {
    if (!input.buyer) {
      throw new Error(
        `Invoice ${iicRef} is electronic (has an EIC) so a partial corrective is process P9 and needs the original buyer. File it in easyPos.`,
      );
    }
    return buildElectronicInvoice({
      docId: input.docId,
      operatorCode: input.operatorCode,
      currency: input.currency,
      invoiceRebate: input.invoiceRebate,
      articles: input.articles,
      payment: input.payment,
      selectedProcess: 'P9',
      buyer: input.buyer,
      correctiveInvoice: ref,
    });
  }
  const request: RegisterInvoiceRequest = {
    ...base(input),
    articles: input.articles,
    payment: input.payment,
    correctiveInvoice: ref,
  };
  assertValidRegisterInvoice(request);
  return request;
}

/**
 * P9/P10 reference an invoice that must itself have an EIC.
 *
 * A corrective pointed at a non-electronic invoice is rejected by the tax
 * service, and the reason it gives is not obviously about the reference.
 */
export function assertCorrectiveTargetIsElectronic(input: {
  process: ElectronicProcess;
  targetEic?: string;
  targetIic?: string;
}): void {
  if (input.process !== 'P9' && input.process !== 'P10') return;
  if (!String(input.targetEic || '').trim()) {
    throw new Error(
      `Process ${input.process} must reference an electronic invoice, but invoice ${
        input.targetIic || '(unknown IIC)'
      } has no EIC recorded. It cannot be corrected or cancelled electronically.`,
    );
  }
}

/** The total a built request declares. Exposed for reporting and receipts. */
export function invoiceTotalOf(request: RegisterInvoiceRequest): number {
  return computeInvoiceTotal(request);
}
