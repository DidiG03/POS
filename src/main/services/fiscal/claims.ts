/**
 * Durable claim on a fiscal registration.
 *
 * Registering an invoice is a side effect on a remote tax service that we
 * cannot undo, so the only defence against registering the same sale twice
 * is a record written BEFORE the request that survives a crash, a lost
 * response, and a retry arriving while the first call is still in flight.
 *
 * Two deliberate choices:
 *
 *   - The claim lives in `SyncState`, not `PrintJob`. Receipt history,
 *     shift summaries and the waiter reports all select `PrintJob` rows by
 *     `type: 'RECEIPT', attempts: 0` with no status filter, so a
 *     placeholder row there would be counted as revenue before the payment
 *     had been fiscalized at all.
 *   - It is also the FIRST place NSLF/NIVF are stored. The `PrintJob`
 *     audit row is written after the print dispatch and can fail; if the
 *     identifiers only lived in its payload, a failed insert would leave
 *     the tax service holding an invoice this POS has no trace of.
 */

import crypto from 'node:crypto';
import { prisma } from '@db/client';
import { notifyAdminsAndActor } from '../adminAlerts';

const KEY_PREFIX = 'fiscal:claim:';

/**
 * How long a PENDING claim can sit before we stop believing another
 * attempt is still working on it. Must comfortably exceed the provider
 * budget in `easyPosRequest` (3 attempts x 20s plus backoff, so ~63s).
 * Past this point the process almost certainly died mid-request and the
 * true outcome is unknowable without checking easyPos.
 */
export const STALE_PENDING_MS = 5 * 60_000;

/** Settled claims are audit trail, but not forever. */
const CLAIM_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

export type FiscalClaimState =
  /** A registration request is in flight. */
  | 'PENDING'
  /** The provider accepted the invoice. Never register this sale again. */
  | 'REGISTERED'
  /** The provider definitively did not register it. Safe to retry. */
  | 'FAILED'
  /** Outcome indeterminate. A human must check easyPos before retrying. */
  | 'UNKNOWN'
  /**
   * The invoice was filed and then the sale changed underneath it — the
   * ticket was voided after payment. The declared document no longer
   * matches what happened, and only a corrective invoice in easyPos can
   * reconcile that.
   */
  | 'CORRECTION_REQUIRED'
  /** An admin confirmed the corrective invoice was filed. */
  | 'CORRECTED';

const CLAIM_STATES: FiscalClaimState[] = [
  'PENDING',
  'REGISTERED',
  'FAILED',
  'UNKNOWN',
  'CORRECTION_REQUIRED',
  'CORRECTED',
];

/** States that mean a person still has work to do in easyPos. */
const REVIEW_STATES = new Set<FiscalClaimState>([
  'UNKNOWN',
  'CORRECTION_REQUIRED',
]);

export interface StoredFiscalResult {
  nslf?: string;
  nivf?: string;
  link?: string;
  status?: 'accepted' | 'pending';
  warning?: string;
}

export interface FiscalClaimRecord {
  state: FiscalClaimState;
  /** Identifies the attempt that currently owns a PENDING claim. */
  attemptId: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  context?: { area?: string; tableLabel?: string; total?: number };
  result?: StoredFiscalResult;
  lastError?: string;
}

export type FiscalClaimDecision =
  /** No prior registration. Caller owns the claim and should fiscalize. */
  | { outcome: 'proceed'; attemptId: string }
  /** Already registered — reuse these identifiers, do not call the provider. */
  | { outcome: 'replay'; result: StoredFiscalResult }
  /** Another attempt is mid-flight. Back off and let it finish. */
  | { outcome: 'in-flight' }
  /** Outcome unknowable. Needs a human to reconcile against easyPos. */
  | {
      outcome: 'needs-review';
      reason: string;
      /**
       * True when an earlier attempt already raised this for review, so a
       * replay of the same payment doesn't re-alert every admin.
       */
      alreadyReported: boolean;
    };

export function fiscalClaimKey(idempotencyKey: string): string {
  return `${KEY_PREFIX}${idempotencyKey}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newAttemptId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function parseRecord(valueJson: unknown): FiscalClaimRecord | null {
  if (!valueJson || typeof valueJson !== 'object') return null;
  const raw = valueJson as Record<string, unknown>;
  const state = String(raw.state || '') as FiscalClaimState;
  if (!CLAIM_STATES.includes(state)) return null;
  return {
    state,
    attemptId: String(raw.attemptId || ''),
    attempts: Number(raw.attempts || 0),
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
    context: (raw.context as FiscalClaimRecord['context']) || undefined,
    result: (raw.result as StoredFiscalResult) || undefined,
    lastError: raw.lastError ? String(raw.lastError) : undefined,
  };
}

export async function readFiscalClaim(
  idempotencyKey: string,
): Promise<FiscalClaimRecord | null> {
  if (!idempotencyKey) return null;
  const row = await prisma.syncState
    .findUnique({ where: { key: fiscalClaimKey(idempotencyKey) } })
    .catch(() => null);
  return parseRecord((row as any)?.valueJson);
}

async function writeClaim(
  idempotencyKey: string,
  record: FiscalClaimRecord,
): Promise<void> {
  const key = fiscalClaimKey(idempotencyKey);
  await prisma.syncState.upsert({
    where: { key },
    create: { key, valueJson: record as any },
    update: { valueJson: record as any },
  });
}

/**
 * Decide whether this attempt may call the fiscal provider, and record the
 * intent durably before it does.
 *
 * Throws if the claim cannot be persisted. That is deliberate: without a
 * durable claim there is nothing stopping a retry from registering the sale
 * a second time, so refusing the payment is the safer failure.
 */
export async function claimFiscalRegistration(
  idempotencyKey: string,
  context?: FiscalClaimRecord['context'],
): Promise<FiscalClaimDecision> {
  if (!idempotencyKey) {
    throw new Error('A fiscal claim requires an idempotency key.');
  }
  void pruneFiscalClaims().catch(() => undefined);

  const attemptId = newAttemptId();
  const key = fiscalClaimKey(idempotencyKey);
  const fresh: FiscalClaimRecord = {
    state: 'PENDING',
    attemptId,
    attempts: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    context,
  };

  try {
    await prisma.syncState.create({
      data: { key, valueJson: fresh as any },
    });
    return { outcome: 'proceed', attemptId };
  } catch (e: any) {
    // P2002 = a claim for this sale already exists. Anything else is a
    // storage failure, and proceeding unclaimed risks a duplicate invoice.
    if (e?.code !== 'P2002') throw e;
  }

  const existing = await readFiscalClaim(idempotencyKey);
  if (!existing) {
    // Row exists but is unreadable. Treat as unknown rather than guessing.
    return {
      outcome: 'needs-review',
      reason: 'Fiscal claim record is corrupt and cannot be interpreted.',
      alreadyReported: false,
    };
  }

  // An invoice exists upstream in all three cases, so never send again.
  if (
    existing.state === 'REGISTERED' ||
    existing.state === 'CORRECTION_REQUIRED' ||
    existing.state === 'CORRECTED'
  ) {
    return { outcome: 'replay', result: existing.result || {} };
  }

  if (existing.state === 'UNKNOWN') {
    return {
      outcome: 'needs-review',
      reason:
        existing.lastError ||
        'A previous attempt ended without a confirmed fiscal outcome.',
      alreadyReported: true,
    };
  }

  if (existing.state === 'PENDING') {
    const startedAt = Date.parse(existing.updatedAt || existing.createdAt);
    const age = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
    if (age < STALE_PENDING_MS) {
      return { outcome: 'in-flight' };
    }
    // Nothing settled this claim within the provider's whole budget, so the
    // process died mid-request. The invoice may or may not exist upstream.
    await writeClaim(idempotencyKey, {
      ...existing,
      state: 'UNKNOWN',
      updatedAt: nowIso(),
      lastError:
        'Fiscalization was interrupted; the provider outcome was never confirmed.',
    });
    return {
      outcome: 'needs-review',
      reason:
        'Fiscalization was interrupted before the provider confirmed the invoice.',
      alreadyReported: false,
    };
  }

  // FAILED: the provider definitively rejected it, so a retry is safe.
  // Take ownership with a new attempt id, then confirm we won the race —
  // if another attempt wrote after us, let that one proceed instead.
  const retry: FiscalClaimRecord = {
    ...existing,
    state: 'PENDING',
    attemptId,
    attempts: existing.attempts + 1,
    updatedAt: nowIso(),
    lastError: undefined,
  };
  await writeClaim(idempotencyKey, retry);
  const confirmed = await readFiscalClaim(idempotencyKey);
  if (confirmed?.attemptId !== attemptId) {
    return { outcome: 'in-flight' };
  }
  return { outcome: 'proceed', attemptId };
}

async function settle(
  idempotencyKey: string,
  attemptId: string,
  patch: Partial<FiscalClaimRecord> & { state: FiscalClaimState },
): Promise<void> {
  const existing = await readFiscalClaim(idempotencyKey);
  if (!existing) return;
  // A settle from a superseded attempt must not overwrite the owner's
  // outcome — in particular it must never downgrade REGISTERED.
  if (existing.attemptId !== attemptId) return;
  await writeClaim(idempotencyKey, {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  });
}

/** The provider accepted the invoice. This sale must never be sent again. */
export async function settleFiscalClaimRegistered(
  idempotencyKey: string,
  attemptId: string,
  result: StoredFiscalResult,
): Promise<void> {
  await settle(idempotencyKey, attemptId, {
    state: 'REGISTERED',
    result,
    lastError: undefined,
  });
}

/** The provider definitively did not register it. A retry is safe. */
export async function settleFiscalClaimFailed(
  idempotencyKey: string,
  attemptId: string,
  error: string,
): Promise<void> {
  await settle(idempotencyKey, attemptId, {
    state: 'FAILED',
    lastError: error,
  });
}

/** We cannot tell whether the invoice registered. Block automatic retries. */
export async function settleFiscalClaimUnknown(
  idempotencyKey: string,
  attemptId: string,
  error: string,
): Promise<void> {
  await settle(idempotencyKey, attemptId, {
    state: 'UNKNOWN',
    lastError: error,
  });
}

/**
 * Resolve a claim a human has reconciled against easyPos, so the sale can
 * either be retried or recorded without another registration.
 */
export async function resolveFiscalClaim(
  idempotencyKey: string,
  resolution: 'retry' | 'registered' | 'corrected',
  result?: StoredFiscalResult,
): Promise<boolean> {
  const existing = await readFiscalClaim(idempotencyKey);
  if (!existing) return false;
  if (resolution === 'corrected') {
    await writeClaim(idempotencyKey, {
      ...existing,
      state: 'CORRECTED',
      updatedAt: nowIso(),
      lastError: undefined,
    });
    return true;
  }
  await writeClaim(idempotencyKey, {
    ...existing,
    state: resolution === 'registered' ? 'REGISTERED' : 'FAILED',
    result: resolution === 'registered' ? result || existing.result : undefined,
    updatedAt: nowIso(),
    lastError:
      resolution === 'registered'
        ? undefined
        : 'Cleared for retry by an admin.',
  });
  return true;
}

/**
 * Record that a filed invoice no longer matches reality.
 *
 * This POS cannot issue the corrective document itself, and quietly
 * closing the table would leave the tax service holding an invoice for a
 * sale that did not happen. So the divergence is stored against the
 * original claim — with the NSLF/NIVF needed to correct it — and pushed to
 * the same review queue as an unconfirmed outcome.
 *
 * Returns false when there was no fiscalized payment to correct.
 */
export async function flagFiscalCorrectionRequired(input: {
  idempotencyKey: string;
  reason: string;
  actorUserId?: number;
  context?: FiscalClaimRecord['context'];
  result?: StoredFiscalResult;
}): Promise<boolean> {
  const key = String(input.idempotencyKey || '').trim();
  if (!key) return false;
  const existing = await readFiscalClaim(key);
  // Already flagged: don't re-alert on a second void of the same ticket.
  if (existing?.state === 'CORRECTION_REQUIRED') return true;

  const record: FiscalClaimRecord = {
    state: 'CORRECTION_REQUIRED',
    attemptId: existing?.attemptId || newAttemptId(),
    attempts: existing?.attempts || 1,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    context: input.context || existing?.context,
    result: input.result || existing?.result,
    lastError: input.reason,
  };
  await writeClaim(key, record);

  const where = [
    record.context?.area,
    record.context?.tableLabel && `Table ${record.context.tableLabel}`,
  ]
    .filter(Boolean)
    .join(' ');
  const ids = [
    record.result?.nivf && `NIVF ${record.result.nivf}`,
    record.result?.nslf && `NSLF ${record.result.nslf}`,
  ].filter(Boolean);
  await notifyAdminsAndActor({
    message:
      `Corrective fiscal invoice required${where ? ` for ${where}` : ''}: ${input.reason}` +
      (ids.length ? ` · ${ids.join(' · ')}` : '') +
      ` · docId ${key} · Issue the correction in easyPos, then mark it done in Settings › Fiskalizimi.`,
    actorUserId: input.actorUserId,
    type: 'SECURITY',
  }).catch(() => undefined);
  return true;
}

/**
 * Drop settled claims past their retention window.
 *
 * Anything still awaiting a human is kept regardless of age — an
 * unreconciled sale does not stop mattering because it got old, and
 * deleting it would erase the only record that it needs attention.
 */
export async function pruneFiscalClaims(options?: {
  /** Skip the once-an-hour throttle that keeps payments from scanning. */
  force?: boolean;
}): Promise<number> {
  const now = Date.now();
  if (!options?.force && now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  lastPruneAt = now;
  const cutoff = new Date(now - CLAIM_TTL_MS);
  const stale = await prisma.syncState
    .findMany({
      where: { key: { startsWith: KEY_PREFIX }, updatedAt: { lt: cutoff } },
    })
    .catch(() => [] as any[]);
  const expired = (stale as any[])
    .filter((row) => {
      const record = parseRecord(row?.valueJson);
      return !record || !REVIEW_STATES.has(record.state);
    })
    .map((row) => String(row.key));
  if (expired.length === 0) return 0;
  const res = await prisma.syncState
    .deleteMany({ where: { key: { in: expired } } })
    .catch(() => ({ count: 0 }));
  return res.count;
}

/**
 * Put a sale that needs manual reconciliation in front of admins.
 *
 * An indeterminate fiscal outcome cannot be resolved by the software:
 * someone has to look up the docId in easyPos and decide whether the
 * invoice exists. Failing quietly here would leave that sale unrecorded
 * with nobody aware of it.
 */
export async function notifyFiscalReviewNeeded(input: {
  idempotencyKey?: string;
  area?: string;
  tableLabel?: string;
  actorUserId?: number;
  message: string;
}): Promise<void> {
  const where = [input.area, input.tableLabel && `Table ${input.tableLabel}`]
    .filter(Boolean)
    .join(' ');
  const message =
    `Fiskalizimi needs review${where ? ` on ${where}` : ''}: ${input.message}` +
    (input.idempotencyKey ? ` · docId ${input.idempotencyKey}` : '') +
    ' · Check easyPos for this docId before taking the payment again.';
  await notifyAdminsAndActor({
    message,
    actorUserId: input.actorUserId,
    type: 'SECURITY',
  });
}

/**
 * The most recent invoice filed for this table since `since`.
 *
 * Reads the claim store rather than `PrintJob` on purpose: the claim is
 * written before the provider call and survives a failed audit insert, so
 * it still finds the invoice in exactly the case where the POS has no
 * receipt row for it.
 */
export async function findRegisteredClaimForTable(input: {
  area: string;
  tableLabel: string;
  since: Date;
}): Promise<{ idempotencyKey: string; record: FiscalClaimRecord } | null> {
  const rows = await prisma.syncState
    .findMany({
      where: {
        key: { startsWith: KEY_PREFIX },
        updatedAt: { gte: input.since },
      },
    })
    .catch(() => [] as any[]);
  let best: { idempotencyKey: string; record: FiscalClaimRecord } | null = null;
  for (const row of rows as any[]) {
    const record = parseRecord(row?.valueJson);
    if (!record || record.state !== 'REGISTERED') continue;
    if (record.context?.area !== input.area) continue;
    if (record.context?.tableLabel !== input.tableLabel) continue;
    if (!best || record.updatedAt > best.record.updatedAt) {
      best = {
        idempotencyKey: String(row.key).slice(KEY_PREFIX.length),
        record,
      };
    }
  }
  return best;
}

/** Every claim awaiting human reconciliation. */
export async function listFiscalClaimsNeedingReview(): Promise<
  Array<{ idempotencyKey: string; record: FiscalClaimRecord }>
> {
  const rows = await prisma.syncState
    .findMany({ where: { key: { startsWith: KEY_PREFIX } } })
    .catch(() => [] as any[]);
  const out: Array<{ idempotencyKey: string; record: FiscalClaimRecord }> = [];
  for (const row of rows as any[]) {
    const record = parseRecord(row?.valueJson);
    if (record && REVIEW_STATES.has(record.state)) {
      out.push({
        idempotencyKey: String(row.key).slice(KEY_PREFIX.length),
        record,
      });
    }
  }
  return out;
}
