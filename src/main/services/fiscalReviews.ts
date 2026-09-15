import { FISCAL_TRANSMIT_WINDOW_MS } from '@shared/fiscalDefer';
import {
  listFiscalClaimsDeferred,
  listFiscalClaimsNeedingReview,
  resolveFiscalClaim,
} from './fiscal';

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
        : ('unknown-outcome' as const),
    area: record.context?.area ?? null,
    tableLabel: record.context?.tableLabel ?? null,
    total: record.context?.total ?? null,
    attempts: record.attempts,
    lastError: record.lastError ?? null,
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
}): Promise<{ ok: boolean; error?: string }> {
  const idempotencyKey = String(payload?.idempotencyKey || '').trim();
  const requested = String(payload?.resolution || '');
  const resolution: 'registered' | 'retry' | 'corrected' =
    requested === 'registered'
      ? 'registered'
      : requested === 'corrected'
        ? 'corrected'
        : 'retry';
  if (!idempotencyKey) return { ok: false, error: 'missing idempotencyKey' };
  const nslf = String(payload?.nslf || '').trim();
  const nivf = String(payload?.nivf || '').trim();
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
  return { ok: true };
}
