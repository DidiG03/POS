/**
 * Cancelling a filed invoice.
 *
 * `POST /invoice/cancel` exists, which the previous code did not know: the
 * comment at the top of `saleCorrection.ts` said easyPos' cloud API "has no
 * route for a cancellation or corrective invoice", so voiding a fiscalized
 * sale only ever raised a note asking an admin to go and do it by hand in
 * easyPos. Every void therefore left the tax service holding an invoice for
 * money nobody collected until somebody remembered.
 *
 * Two rules the API cares about:
 *
 *   - the cancellation is its own business document and needs its own NEW
 *     docId. Reusing the original invoice's docId either collides with it
 *     or makes the two indistinguishable during recovery, which means a
 *     status check can no longer tell you which one it is answering about.
 *   - it references the invoice being cancelled by IIC, through
 *     `correctiveInvoice.iicRef` — not by docId, and not by FIC.
 *
 * Cancelling an electronic invoice is process P10 and the invoice being
 * cancelled must itself have an EIC.
 */

import type { SettingsDTO } from '@shared/ipc';
import type { CancelInvoiceRequest, CorrectiveInvoiceRef } from './apiTypes';
import { assertDistinctCancellationDocId, newDocId } from './docId';
import { assertValidCancelInvoice } from './validate';
import {
  cancelInvoiceWithRecovery,
  type RecoveryOptions,
  type RecoveryResult,
} from './recover';
import { fiscalConfig } from './config';

export interface CancellationTarget {
  /** IIC (NSLF) of the invoice being cancelled. Required. */
  iic: string;
  /** Issue timestamp of the original, when the API asks for it. */
  issueDateTime?: string;
  /** Present only if the original was an electronic invoice. */
  eic?: string;
}

export interface BuildCancellationInput {
  /**
   * A NEW docId for the cancellation. Generate with
   * `newDocId('cancellation')` and persist it before calling.
   */
  docId: string;
  target: CancellationTarget;
  /** The cancelled invoice's docId, so we can refuse to reuse it. */
  originalDocId?: string;
  operatorCode?: string;
  /** True when the original was an electronic invoice. Selects P10. */
  electronic?: boolean;
}

export function buildCancellation(
  input: BuildCancellationInput,
): CancelInvoiceRequest {
  const docId = assertDistinctCancellationDocId({
    cancellationDocId: input.docId,
    originalDocId: input.originalDocId,
  });
  const iicRef = String(input.target?.iic || '').trim();
  if (!iicRef) {
    throw new Error(
      'Cannot cancel an invoice without its IIC — correctiveInvoice.iicRef is required.',
    );
  }
  const electronic = input.electronic === true;
  if (electronic && !String(input.target.eic || '').trim()) {
    throw new Error(
      `Invoice ${iicRef} is being cancelled as electronic (P10) but has no EIC recorded, so the tax service has no electronic document to cancel.`,
    );
  }

  const correctiveInvoice: CorrectiveInvoiceRef = {
    iicRef,
    type: 'CANCELLATION',
    ...(input.target.issueDateTime
      ? { issueDateTimeRef: input.target.issueDateTime }
      : {}),
  };

  const request: CancelInvoiceRequest = {
    docId,
    correctiveInvoice,
    ...(input.operatorCode?.trim()
      ? { operatorCode: input.operatorCode.trim() }
      : {}),
    ...(electronic
      ? { isEinvoice: true, selectedProcess: 'P10' as const }
      : {}),
  };
  assertValidCancelInvoice(request);
  return request;
}

export interface CancelInvoiceInput
  extends Omit<BuildCancellationInput, 'docId' | 'operatorCode'> {
  /** Supply an already-persisted docId, or let one be minted. */
  docId?: string;
  operatorCode?: string;
}

/**
 * File a cancellation, recovering through `/invoice/status` if the outcome
 * is ambiguous.
 *
 * Returns the docId it used even on failure, so the caller can persist it
 * and resume the same cancellation rather than starting a second one.
 */
export async function cancelInvoice(
  settings: SettingsDTO,
  input: CancelInvoiceInput,
  options?: RecoveryOptions,
): Promise<RecoveryResult & { docId: string }> {
  const docId = String(input.docId || '').trim() || newDocId('cancellation');
  const request = buildCancellation({
    ...input,
    docId,
    operatorCode: input.operatorCode ?? fiscalConfig(settings).operatorCode,
  });
  const result = await cancelInvoiceWithRecovery(settings, request, options);
  return { ...result, docId };
}
