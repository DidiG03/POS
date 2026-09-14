/**
 * File a partial corrective invoice (remaining lines, original IIC).
 *
 * Full voids use `POST /invoice/cancel`. A line-item reverse restates the
 * invoice: cloud `POST /invoice/register` with `correctiveInvoice.type =
 * CORRECTIVE`, or P9 when the original was electronic and we still have
 * the buyer. Local middleware gets the same body on `/v1/invoices/new`.
 */

import type { SettingsDTO } from '@shared/ipc';
import type { InvoiceArticle, InvoicePayment, Rebate } from './apiTypes';
import {
  buildCorrectiveInvoice,
  type CorrectiveInvoiceInput,
} from './buildInvoice';
import { newDocId } from './docId';
import { fiscalConfig } from './config';
import {
  createEasyPosSale,
  fiscalOutcomeOf,
  isFiscalRetryable,
} from './easypos';
import {
  registerInvoiceWithRecovery,
  type RecoveryOptions,
  type RecoveryResult,
} from './recover';

export async function registerCorrectiveInvoice(
  settings: SettingsDTO,
  input: Omit<CorrectiveInvoiceInput, 'docId' | 'operatorCode'> & {
    docId?: string;
    operatorCode?: string;
    articles: InvoiceArticle[];
    payment: InvoicePayment[];
    invoiceRebate?: Rebate;
  },
  options?: RecoveryOptions,
): Promise<RecoveryResult & { docId: string }> {
  const docId = String(input.docId || '').trim() || newDocId('invoice');
  const request = buildCorrectiveInvoice({
    ...input,
    docId,
    operatorCode: input.operatorCode ?? fiscalConfig(settings).operatorCode,
  });

  if (!fiscalConfig(settings).cloud) {
    try {
      const { correctiveInvoice, ...rest } = request;
      const result = await createEasyPosSale(settings, {
        app: 'OneTap POS',
        ...rest,
        invoiceType: 'CORRECTIVE',
        iicRef: correctiveInvoice?.iicRef,
      } as any);
      return {
        kind: 'complete',
        docId,
        identifiers: {
          iic: result.nslf || undefined,
          fic: result.nivf || undefined,
          ...(result.eic ? { eic: result.eic } : {}),
          ...(result.link ? { link: result.link } : {}),
        },
        via: 'register',
        sendAttempts: 1,
        statusPolls: 0,
        raw: result.raw,
      };
    } catch (e: any) {
      const message = String(e?.message || e);
      const outcome = fiscalOutcomeOf(e);
      if (outcome === 'not-registered') {
        return {
          kind: isFiscalRetryable(e) ? 'not-registered' : 'rejected',
          docId,
          message,
          sendAttempts: 1,
          statusPolls: 0,
        };
      }
      return {
        kind: 'unresolved',
        docId,
        message,
        sendAttempts: 1,
        statusPolls: 0,
      };
    }
  }

  const result = await registerInvoiceWithRecovery(settings, request, options);
  return { ...result, docId };
}
