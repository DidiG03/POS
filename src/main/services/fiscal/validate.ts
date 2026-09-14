/**
 * Client-side validation for fiscal requests.
 *
 * Every rule here is one the API already enforces. Duplicating them buys
 * two things that matter at a till:
 *
 *   - the failure arrives before the POST, so it cannot end up as an
 *     ambiguous outcome that needs a status check and a human;
 *   - the message names the field, instead of an Albanian fault string
 *     about a document nobody at the counter can see.
 *
 * A rejection here is always safe: nothing has been sent, so nothing was
 * filed, and the docId stays unused.
 */

import { roundMoney } from '@shared/pricing';
import {
  DEFAULT_CURRENCY,
  NUIS_PATTERN,
  OPERATOR_CODE_PATTERN,
  PAYMENT_ACCOUNT_DETAIL_FIELDS,
  PROCESS_REQUIRING_IIC_REF,
  PROCESS_REQUIRING_PREPAID,
  VAT_CODES,
  type CancelInvoiceRequest,
  type InvoiceArticle,
  type InvoicePayment,
  type RegisterInvoiceRequest,
  type Rebate,
} from './apiTypes';
import { validateDocId } from './docId';

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `payment[0].details[0].swift_code`. */
  field: string;
  message: string;
}

export class FiscalValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(
      `Fiscal request is invalid: ${issues
        .map((i) => `${i.field} — ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'FiscalValidationError';
    this.issues = issues;
  }
}

/** A cent of drift is rounding. More is a real disagreement. */
export const TOTAL_TOLERANCE = 0.01;

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */

function rebateIssues(
  rebate: Rebate | undefined,
  field: string,
): ValidationIssue[] {
  if (!rebate) return [];
  const hasPercentage = rebate.inPercentage != null;
  const hasValue = rebate.inValue != null;
  if (hasPercentage && hasValue) {
    return [
      {
        field,
        message:
          'inPercentage and inValue are mutually exclusive — send one or the other, never both.',
      },
    ];
  }
  const issues: ValidationIssue[] = [];
  if (hasPercentage) {
    const p = num(rebate.inPercentage);
    if (p == null || p < 0 || p > 100) {
      issues.push({
        field: `${field}.inPercentage`,
        message: 'Must be a number between 0 and 100.',
      });
    }
  }
  if (hasValue) {
    const v = num(rebate.inValue);
    if (v == null || v < 0) {
      issues.push({
        field: `${field}.inValue`,
        message: 'Must be a non-negative number.',
      });
    }
  }
  return issues;
}

/** Line total after its own rebate. */
export function articleLineTotal(article: InvoiceArticle): number {
  const gross = Number(article.price || 0) * Number(article.units || 0);
  const rebate = article.rebate;
  if (!rebate) return roundMoney(gross);
  if (rebate.inPercentage != null) {
    const pct = Number(rebate.inPercentage) || 0;
    return roundMoney(gross * (1 - pct / 100));
  }
  if (rebate.inValue != null) {
    return roundMoney(gross - (Number(rebate.inValue) || 0));
  }
  return roundMoney(gross);
}

/**
 * The invoice total the payment array has to add up to: line totals after
 * line rebates, then the invoice-level rebate.
 */
export function computeInvoiceTotal(request: {
  articles?: InvoiceArticle[];
  invoiceRebate?: Rebate;
  /** SUMMARY documents carry their total explicitly. */
  total?: number;
  documentType?: string;
}): number {
  if (request.documentType === 'SUMMARY') {
    return roundMoney(request.total ?? 0);
  }
  const lines = (request.articles || []).reduce(
    (sum, article) => sum + articleLineTotal(article),
    0,
  );
  const rebate = request.invoiceRebate;
  if (rebate?.inPercentage != null) {
    return roundMoney(lines * (1 - (Number(rebate.inPercentage) || 0) / 100));
  }
  if (rebate?.inValue != null) {
    return roundMoney(lines - (Number(rebate.inValue) || 0));
  }
  return roundMoney(lines);
}

export function sumPayments(payment: InvoicePayment[] | undefined): number {
  return roundMoney(
    (payment || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
  );
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

function validateArticles(request: RegisterInvoiceRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const documentType = request.documentType || 'NORMAL';
  const articles = request.articles;

  if (documentType === 'SUMMARY') {
    if (articles && articles.length > 0) {
      issues.push({
        field: 'articles',
        message:
          'A SUMMARY invoice must not carry articles — it references ORDER invoices by IIC instead.',
      });
    }
    return issues;
  }

  if (!Array.isArray(articles) || articles.length === 0) {
    issues.push({
      field: 'articles',
      message: `At least one article is required for a ${documentType} invoice.`,
    });
    return issues;
  }

  articles.forEach((article, index) => {
    const at = `articles[${index}]`;
    if (!String(article.articleId || '').trim()) {
      issues.push({ field: `${at}.articleId`, message: 'Required.' });
    } else if (String(article.articleId).trim().length > 100) {
      issues.push({
        field: `${at}.articleId`,
        message: 'Must be at most 100 characters.',
      });
    }
    if (!String(article.name || '').trim()) {
      issues.push({ field: `${at}.name`, message: 'Required.' });
    } else if (String(article.name).trim().length > 100) {
      issues.push({
        field: `${at}.name`,
        message: 'Must be at most 100 characters.',
      });
    }
    if (!String(article.soldIn || '').trim()) {
      issues.push({
        field: `${at}.soldIn`,
        message:
          'Required — the unit of measure must exist in the easyPos catalog.',
      });
    }
    if (!VAT_CODES.includes(article.vatCode)) {
      issues.push({
        field: `${at}.vatCode`,
        message: `"${String(article.vatCode)}" is not a VAT code. Expected one of ${VAT_CODES.join(', ')}, resolved from the stored VAT configuration.`,
      });
    }
    if (documentType === 'EXPORT' && article.vatCode !== 'J') {
      issues.push({
        field: `${at}.vatCode`,
        message: 'An EXPORT invoice must use the export VAT code J.',
      });
    }
    const units = num(article.units);
    if (units == null || units <= 0) {
      issues.push({
        field: `${at}.units`,
        message: 'Must be greater than zero.',
      });
    }
    if (num(article.price) == null) {
      issues.push({ field: `${at}.price`, message: 'Must be a number.' });
    } else if (Number(article.price) < 0) {
      issues.push({
        field: `${at}.price`,
        message:
          'Must be zero or greater. Discounts belong on rebate or invoiceRebate, not a negative unit price.',
      });
    }
    issues.push(...rebateIssues(article.rebate, `${at}.rebate`));
  });

  return issues;
}

function validatePayment(request: RegisterInvoiceRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const documentType = request.documentType || 'NORMAL';
  const payment = request.payment;

  if (documentType === 'ORDER') {
    // Not "empty array" — the field must be absent. An ORDER is generated
    // as an order precisely because it carries no payment.
    if (payment !== undefined) {
      issues.push({
        field: 'payment',
        message:
          'An ORDER invoice must omit payment entirely; it is settled later by a SUMMARY invoice.',
      });
    }
    return issues;
  }

  if (!Array.isArray(payment) || payment.length === 0) {
    issues.push({
      field: 'payment',
      message: `At least one payment entry is required for a ${documentType} invoice.`,
    });
    return issues;
  }

  payment.forEach((entry, index) => {
    const at = `payment[${index}]`;
    if (!String(entry.type || '').trim()) {
      issues.push({ field: `${at}.type`, message: 'Required.' });
    }
    if (num(entry.amount) == null) {
      issues.push({ field: `${at}.amount`, message: 'Must be a number.' });
    }
    if (entry.type === 'ACCOUNT') {
      const details = entry.details;
      if (!Array.isArray(details) || details.length === 0) {
        issues.push({
          field: `${at}.details`,
          message:
            'An ACCOUNT payment requires at least one bank account entry in details[].',
        });
      } else {
        details.forEach((detail, di) => {
          for (const field of PAYMENT_ACCOUNT_DETAIL_FIELDS) {
            if (!String((detail as any)?.[field] ?? '').trim()) {
              issues.push({
                field: `${at}.details[${di}].${field}`,
                message: 'Required — all seven account fields must be present.',
              });
            }
          }
        });
      }
    }
  });

  const expected = computeInvoiceTotal(request);
  const paid = sumPayments(payment);
  if (Math.abs(roundMoney(paid - expected)) > TOTAL_TOLERANCE) {
    issues.push({
      field: 'payment',
      message: `Payment amounts total ${paid.toFixed(2)} but the invoice total is ${expected.toFixed(2)}. The API requires them to match exactly.`,
    });
  }

  return issues;
}

function validateBuyer(request: RegisterInvoiceRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const documentType = request.documentType || 'NORMAL';
  const required =
    request.isEinvoice === true ||
    documentType === 'EXPORT' ||
    documentType === 'SELFISSUE';
  const buyer = request.buyer;

  if (!buyer) {
    if (required) {
      issues.push({
        field: 'buyer',
        message:
          request.isEinvoice === true
            ? 'Buyer details are required for an electronic invoice.'
            : `Buyer details are required for a ${documentType} invoice.`,
      });
    }
    return issues;
  }

  if (!String(buyer.name || '').trim()) {
    issues.push({ field: 'buyer.name', message: 'Required.' });
  }
  const id = String(buyer.buyerID || '').trim();
  if (!id) {
    issues.push({ field: 'buyer.buyerID', message: 'Required.' });
  } else if (buyer.buyerIDType === 'NUIS' && !NUIS_PATTERN.test(id)) {
    issues.push({
      field: 'buyer.buyerID',
      message: `"${id}" is not a NUIS. Expected a letter, eight digits and a letter (e.g. L41323029B).`,
    });
  }
  if (documentType === 'EXPORT') {
    const countryCode = String(buyer.countryCode || '')
      .trim()
      .toUpperCase();
    if (!countryCode) {
      issues.push({
        field: 'buyer.countryCode',
        message: 'Required for an EXPORT invoice — the buyer must be foreign.',
      });
    } else if (countryCode === 'AL') {
      issues.push({
        field: 'buyer.countryCode',
        message: 'An EXPORT invoice needs a foreign buyer; AL is not valid.',
      });
    }
  }
  return issues;
}

function validateDocumentType(
  request: RegisterInvoiceRequest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const documentType = request.documentType || 'NORMAL';

  if (documentType === 'SUMMARY') {
    const refs = request.summaryInvoices;
    if (!Array.isArray(refs) || refs.length === 0) {
      issues.push({
        field: 'summaryInvoices',
        message:
          'A SUMMARY invoice must reference at least one ORDER invoice by IIC.',
      });
    } else {
      refs.forEach((ref, index) => {
        if (!String(ref?.iic || '').trim()) {
          issues.push({
            field: `summaryInvoices[${index}].iic`,
            message: 'Required.',
          });
        }
      });
    }
    if (num(request.total) == null) {
      issues.push({
        field: 'total',
        message:
          'A SUMMARY invoice must state its total, and it must equal the referenced ORDER total exactly.',
      });
    }
  }

  if (documentType === 'SELFISSUE') {
    if (!String(request.selfIssueType || '').trim()) {
      issues.push({
        field: 'selfIssueType',
        message: 'Required for SELFISSUE.',
      });
    }
    if (typeof request.reverseCharge !== 'boolean') {
      issues.push({
        field: 'reverseCharge',
        message: 'Required for SELFISSUE — send true or false explicitly.',
      });
    }
  }

  if (documentType === 'EXPORT') {
    const period = request.supplyPeriod;
    if (!period?.start || !period?.end) {
      issues.push({
        field: 'supplyPeriod',
        message: 'An EXPORT invoice requires supplyPeriod.start and .end.',
      });
    }
  }

  return issues;
}

function validateElectronic(
  request: RegisterInvoiceRequest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const process = request.selectedProcess;

  if (request.isEinvoice === true && !process) {
    issues.push({
      field: 'selectedProcess',
      message: 'An electronic invoice must name its process (P1–P11).',
    });
  }
  if (process && request.isEinvoice !== true) {
    issues.push({
      field: 'isEinvoice',
      message: `selectedProcess ${process} was set, so isEinvoice must be true.`,
    });
  }

  const needsPrepaid = !!process && PROCESS_REQUIRING_PREPAID.includes(process);
  const prepaid = num(request.prepaidAmount);
  if (needsPrepaid) {
    const total = computeInvoiceTotal(request);
    if (prepaid == null) {
      issues.push({
        field: 'prepaidAmount',
        message: 'Required for process P4.',
      });
    } else if (prepaid <= 0) {
      issues.push({
        field: 'prepaidAmount',
        message: 'Must be greater than zero.',
      });
    } else if (roundMoney(prepaid - total) > TOTAL_TOLERANCE) {
      issues.push({
        field: 'prepaidAmount',
        message: `Must not exceed the invoice total (${prepaid.toFixed(2)} > ${total.toFixed(2)}).`,
      });
    }
  } else if (request.prepaidAmount !== undefined) {
    issues.push({
      field: 'prepaidAmount',
      message: `prepaidAmount only applies to process P4, not ${process || request.documentType || 'NORMAL'}.`,
    });
  }

  if (!!process && PROCESS_REQUIRING_IIC_REF.includes(process)) {
    if (!String(request.correctiveInvoice?.iicRef || '').trim()) {
      issues.push({
        field: 'correctiveInvoice.iicRef',
        message: `Process ${process} must reference the IIC of the invoice it corrects or cancels.`,
      });
    }
  }

  return issues;
}

function validateCurrency(request: RegisterInvoiceRequest): ValidationIssue[] {
  const currency = request.currency;
  if (!currency) return [];
  const code = String(currency.code || '')
    .trim()
    .toUpperCase();
  if (!code) {
    return [
      { field: 'currency.code', message: 'Required when currency is sent.' },
    ];
  }
  if (code === DEFAULT_CURRENCY) return [];
  const rate = num(currency.exRate);
  if (rate == null || rate <= 0) {
    return [
      {
        field: 'currency.exRate',
        message: `An exchange rate against ${DEFAULT_CURRENCY} is required for currency ${code}.`,
      },
    ];
  }
  return [];
}

function validateOperator(
  operatorCode: unknown,
  field = 'operatorCode',
): ValidationIssue[] {
  const code = String(operatorCode ?? '').trim();
  if (!code) return [];
  if (!OPERATOR_CODE_PATTERN.test(code)) {
    return [
      {
        field,
        message: `"${code}" is not a valid operator code (expected two letters, three digits, two letters, three digits — e.g. gh537ez280). Pick one returned by /utilities/get-operators.`,
      },
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

export function validateRegisterInvoice(
  request: RegisterInvoiceRequest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const doc = validateDocId(request.docId);
  if (!doc.ok) issues.push({ field: 'docId', message: doc.error! });
  issues.push(...validateDocumentType(request));
  issues.push(...validateArticles(request));
  issues.push(...validatePayment(request));
  issues.push(...validateBuyer(request));
  issues.push(...validateElectronic(request));
  issues.push(...validateCurrency(request));
  issues.push(...validateOperator(request.operatorCode));
  issues.push(...rebateIssues(request.invoiceRebate, 'invoiceRebate'));
  return issues;
}

export function assertValidRegisterInvoice(
  request: RegisterInvoiceRequest,
): void {
  const issues = validateRegisterInvoice(request);
  if (issues.length) throw new FiscalValidationError(issues);
}

export function validateCancelInvoice(
  request: CancelInvoiceRequest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const doc = validateDocId(request.docId);
  if (!doc.ok) issues.push({ field: 'docId', message: doc.error! });
  if (!String(request.correctiveInvoice?.iicRef || '').trim()) {
    issues.push({
      field: 'correctiveInvoice.iicRef',
      message:
        'A cancellation must reference the IIC of the invoice being cancelled.',
    });
  }
  if (request.isEinvoice === true && request.selectedProcess !== 'P10') {
    issues.push({
      field: 'selectedProcess',
      message: 'Cancelling an electronic invoice uses process P10.',
    });
  }
  if (request.isEinvoice !== true && request.selectedProcess) {
    issues.push({
      field: 'selectedProcess',
      message:
        'A non-electronic cancellation must not name an electronic process.',
    });
  }
  issues.push(...validateOperator(request.operatorCode));
  return issues;
}

export function assertValidCancelInvoice(request: CancelInvoiceRequest): void {
  const issues = validateCancelInvoice(request);
  if (issues.length) throw new FiscalValidationError(issues);
}

/** Normalise a NUIS to the uppercase form the API expects. */
export function normalizeNuis(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase();
}

export { validateOperator as validateOperatorCode };
