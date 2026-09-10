/**
 * The completion contract.
 *
 * easyPos answers HTTP 200 for requests that did not produce a document.
 * The body decides, and which field decides depends on what was asked:
 *
 *   - invoice / cancellation      → `fic`
 *   - electronic invoice or       → `fic` AND `eic`
 *     electronic cancellation
 *   - cash balance operation      → `fcdc`
 *   - PDF                         → `base64`
 *
 * Anything else is incomplete, however encouraging the rest of the body
 * looks. Two specific traps this module exists to close:
 *
 *   - `iic` (NSLF) is allocated by the fiscal device before the tax service
 *     is even contacted, so an `iic` with no `fic` is a document that was
 *     prepared and not filed. Treating it as a partial success printed
 *     receipts claiming fiskalizimi and recorded revenue against invoices
 *     that do not exist.
 *   - an electronic invoice with `fic` but no `eic` is filed for tax but
 *     not delivered as an e-invoice. Calling that done leaves the buyer
 *     without the document they are legally owed and nobody looking for it.
 */

import type { FiscalApiResponse } from './apiTypes';

export type CompletionTarget =
  /** Plain invoice or plain cancellation: `fic`. */
  | 'invoice'
  /** `isEinvoice: true` register or a P10 cancellation: `fic` + `eic`. */
  | 'electronic-invoice'
  /** initiate / deposit / withdraw: `fcdc`. */
  | 'balance'
  /** `/invoice/pdf`: `base64`. */
  | 'pdf';

/** The field(s) whose presence means the request completed. */
export const COMPLETION_FIELDS: Readonly<
  Record<CompletionTarget, readonly string[]>
> = {
  invoice: ['fic'],
  'electronic-invoice': ['fic', 'eic'],
  balance: ['fcdc'],
  pdf: ['base64'],
};

export interface FiscalIdentifiers {
  /** NSLF. */
  iic?: string;
  /** NIVF. */
  fic?: string;
  eic?: string;
  fcdc?: string;
  base64?: string;
  link?: string;
  qrCode?: string;
  iicSignature?: string;
}

export type CompletionVerdict =
  | { complete: true; identifiers: FiscalIdentifiers }
  | {
      complete: false;
      identifiers: FiscalIdentifiers;
      /** Which required fields were absent. */
      missing: string[];
      reason: string;
    };

function text(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

/**
 * Pull identifiers out of a response body.
 *
 * easyPos has shipped these at the top level and nested under `response`
 * (and the legacy local middleware used the Albanian names NSLF/NIVF), so
 * read every shape rather than depending on which one is in front of us.
 */
export function readIdentifiers(data: unknown): FiscalIdentifiers {
  const body = (data || {}) as FiscalApiResponse;
  const nested = (body.response || {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const found =
        text((body as Record<string, unknown>)[key]) ?? text(nested[key]);
      if (found) return found;
    }
    return undefined;
  };
  return {
    iic: pick('iic', 'IIC', 'nslf', 'NSLF'),
    fic: pick('fic', 'FIC', 'nivf', 'NIVF'),
    eic: pick('eic', 'EIC'),
    fcdc: pick('fcdc', 'FCDC'),
    base64: pick('base64', 'pdf', 'pdfBase64'),
    link: pick('link', 'verificationUrl', 'verificationLink'),
    qrCode: pick('qrCode', 'qrcode'),
    iicSignature: pick('iicSignature', 'iicsignature'),
  };
}

/**
 * Human-readable fault text from a response body.
 *
 * The one extractor every fiscal path uses. Previously `completion.ts`,
 * `classify.ts` and `easypos.ts` each had their own, and they disagreed:
 * `easypos` would stringify the error envelope as `[object Object]`,
 * `classify` included the CIS environment the others dropped, and
 * `completion` stopped at the two CIS/otherError strings. One function
 * means a hint, a classification and an incomplete-reason all quote the
 * same sentence.
 */
export function readFaultText(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (typeof data === 'string') return text(data);

  const body = data as FiscalApiResponse;
  const cis = body.error?.cisError;
  const cisString = text(cis?.faultString);
  if (cisString || text(cis?.faultCode) || text(cis?.faultEnv)) {
    const bits = [
      cisString,
      text(cis?.faultCode) && `code ${cis!.faultCode}`,
      text(cis?.faultEnv),
    ].filter(Boolean);
    if (bits.length) return bits.join(' · ');
  }

  const other = text(body.error?.otherError?.message);
  if (other) return other;

  const nested = (body.response || {}) as Record<string, unknown>;
  const direct =
    text(body.message) ?? text(nested.text) ?? text(nested.message);
  if (direct) return direct;

  if (typeof body.error === 'string') {
    const fromError = text(body.error);
    if (fromError) return fromError;
  }

  const extras = body as Record<string, unknown>;
  for (const key of ['text', 'title', 'detail', 'statusText'] as const) {
    const found = text(extras[key]);
    if (found) return found;
  }

  const errors = extras.errors;
  if (Array.isArray(errors) && errors.length) {
    const joined = errors
      .map((entry) => text((entry as any)?.message) ?? text(entry))
      .filter(Boolean)
      .join('; ');
    if (joined) return joined;
  }

  return undefined;
}

/**
 * Decide whether a response completed the operation it was sent for.
 *
 * Deliberately takes no HTTP status: a caller cannot accidentally satisfy
 * this by passing `res.ok`.
 */
export function assessCompletion(
  target: CompletionTarget,
  data: unknown,
): CompletionVerdict {
  const identifiers = readIdentifiers(data);
  const required = COMPLETION_FIELDS[target];
  const missing = required.filter(
    (field) => !text((identifiers as Record<string, unknown>)[field]),
  );
  if (missing.length === 0) return { complete: true, identifiers };

  const fault = readFaultText(data);
  return {
    complete: false,
    identifiers,
    missing: [...missing],
    reason: fault || describeIncomplete(target, missing, identifiers),
  };
}

function describeIncomplete(
  target: CompletionTarget,
  missing: string[],
  identifiers: FiscalIdentifiers,
): string {
  if (
    target === 'electronic-invoice' &&
    missing.length === 1 &&
    identifiers.fic
  ) {
    return `Electronic invoice was filed (NIVF ${identifiers.fic}) but the API returned no EIC, so it has not been delivered as an e-invoice.`;
  }
  if (target === 'invoice' && identifiers.iic) {
    return `The fiscal device allocated NSLF ${identifiers.iic} but the tax service returned no NIVF, so the invoice is not registered.`;
  }
  const label: Record<CompletionTarget, string> = {
    invoice: 'Invoice',
    'electronic-invoice': 'Electronic invoice',
    balance: 'Cash balance operation',
    pdf: 'PDF generation',
  };
  return `${label[target]} did not complete: the API returned no ${missing.join(' and no ')}.`;
}

/** Which contract a register/cancel request must be judged against. */
export function targetForInvoice(input: {
  isEinvoice?: boolean;
}): CompletionTarget {
  return input.isEinvoice === true ? 'electronic-invoice' : 'invoice';
}
