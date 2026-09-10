/**
 * `POST /invoice/pdf`.
 *
 * The one rule with teeth: only ask for a PDF of a document that is
 * actually complete. A PDF request for an invoice with no `fic` either
 * fails or — worse — returns a rendered document for something the tax
 * service has not registered, which then gets handed to a customer as
 * proof of an invoice that does not exist.
 *
 * So the caller has to pass the identifiers it holds, and this refuses if
 * they do not satisfy the same completion contract the register call was
 * judged against.
 */

import type { SettingsDTO } from '@shared/ipc';
import {
  PDF_LANGS,
  PDF_PAPER_WIDTHS,
  PDF_TYPES,
  type InvoicePdfRequest,
  type PdfLang,
  type PdfPaperWidth,
  type PdfType,
} from './apiTypes';
import { assertValidDocId } from './docId';
import { postInvoicePdf, withDocIdLock } from './client';
import { assessCompletion, readFaultText } from './completion';
import { classifyFiscalAttempt } from './classify';

export interface PdfSourceInvoice {
  /** NIVF. Required — its absence means the invoice is not registered. */
  fic?: string;
  /** Required as well when the source was an electronic invoice. */
  eic?: string;
  isEinvoice?: boolean;
}

export interface RequestPdfInput {
  /** docId of the invoice or cancellation to render. */
  docId: string;
  pdfType: PdfType;
  /** `receipt` only: 58, 80 or 110. */
  paperWidth?: PdfPaperWidth;
  lang?: PdfLang;
  /** What we know about the document being rendered. */
  source: PdfSourceInvoice;
}

export type PdfOutcome =
  | { kind: 'ok'; base64: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'unresolved'; message: string };

export function buildPdfRequest(input: RequestPdfInput): InvoicePdfRequest {
  const docId = assertValidDocId(input.docId);
  if (!PDF_TYPES.includes(input.pdfType)) {
    throw new Error(
      `pdfType must be one of ${PDF_TYPES.join(', ')} (got "${String(input.pdfType)}").`,
    );
  }
  if (input.paperWidth !== undefined) {
    if (input.pdfType !== 'receipt') {
      throw new Error(
        `paperWidth only applies to pdfType "receipt", not "${input.pdfType}".`,
      );
    }
    if (!PDF_PAPER_WIDTHS.includes(input.paperWidth)) {
      throw new Error(
        `paperWidth must be one of ${PDF_PAPER_WIDTHS.join(', ')} (got ${String(input.paperWidth)}).`,
      );
    }
  }
  if (input.lang !== undefined && !PDF_LANGS.includes(input.lang)) {
    throw new Error(
      `lang must be one of ${PDF_LANGS.join(', ')} (got "${String(input.lang)}").`,
    );
  }

  // Gate on the source document, not on the PDF request itself.
  const verdict = assessCompletion(
    input.source.isEinvoice === true ? 'electronic-invoice' : 'invoice',
    input.source,
  );
  if (!verdict.complete) {
    throw new Error(
      `Refusing to render a PDF for docId ${docId}: ${verdict.reason} A PDF must only be produced for a registered document.`,
    );
  }

  return {
    docId,
    pdfType: input.pdfType,
    ...(input.paperWidth !== undefined ? { paperWidth: input.paperWidth } : {}),
    ...(input.lang !== undefined ? { lang: input.lang } : {}),
  };
}

/**
 * Fetch a PDF. Completion is `base64` — an HTTP 200 with an empty body is
 * a failure, and returning it would write a zero-byte PDF to disk.
 */
export async function requestInvoicePdf(
  settings: SettingsDTO,
  input: RequestPdfInput,
): Promise<PdfOutcome> {
  const request = buildPdfRequest(input);
  return withDocIdLock(request.docId, async () => {
    let result;
    try {
      result = await postInvoicePdf(settings, request);
    } catch (e) {
      const classification = classifyFiscalAttempt({ error: e });
      return { kind: 'unresolved' as const, message: classification.message };
    }
    const verdict = assessCompletion('pdf', result.data);
    if (verdict.complete) {
      return {
        kind: 'ok' as const,
        base64: String(verdict.identifiers.base64),
      };
    }
    const classification = classifyFiscalAttempt({
      httpStatus: result.httpStatus,
      data: result.data,
      incomplete: true,
      incompleteReason: verdict.reason,
    });
    const detail = readFaultText(result.data) || verdict.reason;
    return classification.retryable
      ? { kind: 'unresolved' as const, message: detail }
      : { kind: 'rejected' as const, message: detail };
  });
}
