import { FISCAL_TRANSMIT_WINDOW_MS } from '@shared/fiscalDefer';
import { heldClaimIsDefinitelyNotFiled } from './fiscal/claims';
import {
  listFiscalClaimsDeferred,
  listFiscalClaimsNeedingReview,
  readFiscalClaim,
  resolveFiscalClaim,
} from './fiscal';
import { retryFiscalReview } from './fiscal/reviewRetry';
import { stampFiscalIdentifiersOnSale } from './fiscal/deferred';
import { coreServices } from './core';

export async function listFiscalReviewsForAdmin() {
  const [review, deferred] = await Promise.all([
    listFiscalClaimsNeedingReview(),
    listFiscalClaimsDeferred(),
  ]);
  const mappedReview = review.map(({ idempotencyKey, record }) => ({
    idempotencyKey,
    kind:
      record.state === 'CORRECTION_REQUIRED'
        ? ('correction-required' as const)
        : record.state === 'REGISTERED'
          ? ('unrecorded' as const)
          : // Held and certainly not filed: refused by easyPos, or never
            // sent (QA v0.2.104, #11). "Send again" needs no lookup.
            heldClaimIsDefinitelyNotFiled(record)
            ? record.holdKind === 'rejected'
              ? ('rejected' as const)
              : ('not-sent' as const)
            : // UNKNOWN, or held because a send may have been filed.
              ('unknown-outcome' as const),
    area: record.context?.area ?? null,
    tableLabel: record.context?.tableLabel ?? null,
    total: record.context?.total ?? null,
    attempts: record.attempts,
    lastError: record.holdReason ?? record.lastError ?? null,
    nslf: record.result?.nslf ?? null,
    nivf: record.result?.nivf ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deadlineAt: null as string | null,
  }));
  const mappedDeferred = deferred.map(({ idempotencyKey, record }) => ({
    idempotencyKey,
    kind: 'deferred' as const,
    area: record.context?.area ?? null,
    tableLabel: record.context?.tableLabel ?? null,
    total: record.context?.total ?? null,
    attempts: record.attempts,
    lastError: record.lastError ?? null,
    nslf: record.result?.nslf ?? null,
    nivf: record.result?.nivf ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deadlineAt: new Date(
      Date.parse(record.createdAt) + FISCAL_TRANSMIT_WINDOW_MS,
    ).toISOString(),
  }));
  return [...mappedDeferred, ...mappedReview];
}

export async function resolveFiscalReviewForAdmin(payload: {
  idempotencyKey?: string;
  resolution?: string;
  nslf?: string;
  nivf?: string;
  /** The reviewer looked the docId up in easyPos and it is not there. */
  confirmedNotFiled?: boolean;
}): Promise<{ ok: boolean; error?: string; code?: string; outcome?: string }> {
  const idempotencyKey = String(payload?.idempotencyKey || '').trim();
  const requested = String(payload?.resolution || '');
  const resolution: 'registered' | 'retry' | 'corrected' =
    requested === 'registered'
      ? 'registered'
      : requested === 'corrected'
        ? 'corrected'
        : 'retry';
  if (!idempotencyKey) return { ok: false, error: 'missing idempotencyKey' };
  if (resolution === 'retry') {
    // Checked, atomic per sale, never a blind resend (`reviewRetry.ts`).
    const settings = await coreServices.readSettings();
    const r = await retryFiscalReview({
      idempotencyKey,
      settings: settings as any,
      confirmedNotFiled: payload?.confirmedNotFiled === true,
      stampSale: stampFiscalIdentifiersOnSale,
    });
    return r.ok
      ? { ok: true, outcome: r.outcome }
      : { ok: false, error: r.error, code: r.code };
  }
  const nslf = String(payload?.nslf || '').trim();
  const nivf = String(payload?.nivf || '').trim();
  const before =
    resolution === 'registered' ? await readFiscalClaim(idempotencyKey) : null;
  const ok = await resolveFiscalClaim(
    idempotencyKey,
    resolution,
    resolution === 'registered'
      ? {
          nslf: nslf || undefined,
          nivf: nivf || undefined,
          status: 'accepted',
        }
      : undefined,
  );
  if (!ok) return { ok: false, error: 'claim not found' };
  if (resolution === 'registered' && (nslf || nivf)) {
    // The sale was recorded as "not yet fiscalised": put the codes on it.
    const saleKey =
      String(before?.context?.saleKey || '').trim() || idempotencyKey;
    await stampFiscalIdentifiersOnSale(saleKey, {
      nslf: nslf || undefined,
      nivf: nivf || undefined,
      status: 'accepted',
    }).catch(() => undefined);
  }
  return { ok: true };
}
