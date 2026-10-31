/**
 * Builders for each document type the API accepts.
 *
 * The till files normal sales, electronic invoices and correctives. One
 * builder per type rather than a single bag of optional fields: expressing
 * the types as "pass whatever you have" is how a document ends up carrying
 * fields its type forbids and the tax service rejects an invoice the till
 * has already collected money for.
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
} from './apiTypes';
import { assertValidDocId } from './docId';
import {
  assertValidRegisterInvoice,
  computeInvoiceTotal,
  normalizeNuis,
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
 * A corrective invoice for a partial void: the struck lines with negative
 * units (positive prices) and a negative payment, referencing the original
 * by IIC. CIS then nets original + corrective to what the guest paid.
 *
 * The reference is `{ iicRef }` only: easyPos answers HTTP 400 "Unknown
 * fields found" for `type` and `issueDateTimeRef`, and `issueDateTime`
 * defaults to the original invoice's. Electronic originals are P9 and need
 * the buyer from the original e-invoice — without that we refuse rather
 * than file a P9 CIS will reject.
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
  const ref: CorrectiveInvoiceRef = { iicRef };
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

/** The total a built request declares. Exposed for reporting and receipts. */
export function invoiceTotalOf(request: RegisterInvoiceRequest): number {
  return computeInvoiceTotal(request);
}
