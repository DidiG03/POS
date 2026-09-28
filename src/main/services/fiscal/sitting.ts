/**
 * One sitting, one invoice.
 *
 * `fiscalizePaymentOnce` stops the *same payment* from being filed twice:
 * every retry of one Pay tap carries one idempotency key, and the claim for
 * that key decides. What it cannot see is a *second* Pay tap for the same
 * table, which gets a new key and therefore a new, unused docId. Two real
 * ways that happens:
 *
 *   - the invoice is filed, then the till dies (power cut, crash, restart)
 *     before the sale is saved. The table is still open, nothing on screen
 *     says it was paid, and the waiter takes the payment again;
 *   - a payment comes back "needs review", an admin confirms in easyPos that
 *     the invoice exists, and someone taps Pay again instead of retrying the
 *     parked payment.
 *
 * Both file a second invoice for one sale. So before a payment is sent, the
 * table's current sitting is checked for an invoice that may already exist
 * without a saved sale:
 *
 *   - filed, not saved, same total → the payment reuses that invoice (no new
 *     one is filed) and the sale is saved against it;
 *   - anything else unresolved → the payment is held with an explanation,
 *     and the claim is on the admin review list.
 *
 * `sweepFiscalClaims` finds the same situations without waiting for a
 * payment, so an interrupted send never sits invisibly in the claim store.
 */

import { prisma } from '@db/client';
import { getTableSessionStartedAt } from '../tableSession';
import { notifyAdminsAndActor } from '../adminAlerts';
import { readLedgerErasedAt } from '../ledgerErase';
import { docIdFromKey } from './docId';
import {
  annotateFiscalClaimUnlocked,
  isDeadPendingClaim,
  isFiscalClaimLocked,
  listFiscalClaimsUpdatedSince,
  markDeadPendingUnknownUnlocked,
  notifyFiscalReviewNeeded,
  withFiscalClaimLock,
  type FiscalClaimRecord,
} from './claims';

/** A sitting with no recorded start is looked back over this far. */
const FALLBACK_LOOKBACK_MS = 12 * 60 * 60 * 1000;

/**
 * How long after filing an invoice may legitimately have no saved sale:
 * the payment is still printing. Past this the till has lost it.
 */
export const ORPHAN_GRACE_MS = 10 * 60_000;

/** The sweep looks this far back; older problems were already surfaced. */
const SWEEP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Totals within half a cent are the same amount. */
const SAME_TOTAL_EPSILON = 0.005;

type ClaimRow = { idempotencyKey: string; record: FiscalClaimRecord };

export type SittingCheck =
  /** Nothing unresolved for this sitting. File as usual. */
  | { kind: 'clear' }
  /**
   * This sitting already has a filed invoice for this exact amount that no
   * sale was ever saved against. Reuse it: fiscalize under `docId` (which
   * replays the stored identifiers) and save the sale.
   */
  | { kind: 'adopt'; docId: string; nivf?: string }
  /** Hold the payment. `retryable` means waiting will resolve it. */
  | {
      kind: 'blocked';
      code: 'FISCAL_SITTING_UNRESOLVED' | 'FISCAL_SITTING_BUSY';
      message: string;
      docId: string;
      retryable: boolean;
    };

/** Every key the sale behind a claim may be saved under. */
function saleKeysOf(row: ClaimRow): string[] {
  const keys = new Set<string>([row.idempotencyKey]);
  const saleKey = String(row.record.context?.saleKey || '').trim();
  if (saleKey) keys.add(saleKey);
  return [...keys];
}

/** The subset of `keys` that have a saved receipt or payment. */
export async function recordedSaleKeys(keys: string[]): Promise<Set<string>> {
  const unique = [...new Set(keys.filter(Boolean))];
  const found = new Set<string>();
  if (unique.length === 0) return found;
  const [jobs, payments] = await Promise.all([
    (prisma as any).printJob
      .findMany({
        where: { idempotencyKey: { in: unique } },
        select: { idempotencyKey: true },
      })
      .catch(() => [] as any[]),
    (prisma as any).payment
      .findMany({
        where: { idempotencyKey: { in: unique } },
        select: { idempotencyKey: true },
      })
      .catch(() => [] as any[]),
  ]);
  for (const row of [...(jobs as any[]), ...(payments as any[])]) {
    const key = String(row?.idempotencyKey || '').trim();
    if (key) found.add(key);
  }
  return found;
}

function isRecorded(row: ClaimRow, recorded: Set<string>): boolean {
  return saleKeysOf(row).some((key) => recorded.has(key));
}

function createdAtMs(record: FiscalClaimRecord): number {
  const at = Date.parse(record.createdAt || record.updatedAt);
  return Number.isFinite(at) ? at : 0;
}

function where(area: string, tableLabel: string): string {
  return [area, tableLabel && `Table ${tableLabel}`].filter(Boolean).join(' ');
}

function money(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

/** Flag an invoice with no saved sale, telling admins the first time only. */
async function flagOrphan(row: ClaimRow, now: number): Promise<void> {
  if (row.record.orphanDetectedAt) return;
  await withFiscalClaimLock(row.idempotencyKey, () =>
    annotateFiscalClaimUnlocked(row.idempotencyKey, {
      orphanDetectedAt: new Date(now).toISOString(),
    }),
  );
  const ctx = row.record.context || {};
  await notifyAdminsAndActor({
    message:
      `Fiskalizimi: an invoice was filed${ctx.area || ctx.tableLabel ? ` for ${where(String(ctx.area || ''), String(ctx.tableLabel || ''))}` : ''}` +
      ` (NIVF ${row.record.result?.nivf || '—'}, total ${money(ctx.total)}) but no sale was saved for it` +
      ` — the till probably closed or lost power mid-payment · docId ${row.idempotencyKey}.` +
      ' If that table is still open, taking its payment again reuses this invoice. Otherwise check it in Settings › Fiskalizimi.',
    type: 'SECURITY',
  }).catch(() => undefined);
}

/** Move an interrupted send to review and tell admins. Returns true if it did. */
async function surfaceDeadPending(row: ClaimRow): Promise<boolean> {
  const converted = await withFiscalClaimLock(
    row.idempotencyKey,
    () => markDeadPendingUnknownUnlocked(row.idempotencyKey),
    1_000,
  ).catch(() => false);
  if (converted) {
    const ctx = row.record.context || {};
    await notifyFiscalReviewNeeded({
      idempotencyKey: row.idempotencyKey,
      area: ctx.area,
      tableLabel: ctx.tableLabel,
      message:
        'A payment was interrupted while it was being sent (the till closed or lost power), so it is not known whether its invoice was filed.',
    }).catch(() => undefined);
  }
  return converted;
}

/**
 * Decide whether a payment for this table may be fiscalized under its own
 * new docId. Call it while holding the table's payment lock, after the
 * table-open check and before `fiscalizePaymentOnce`.
 */
export async function checkSittingBeforePayment(input: {
  area: string;
  tableLabel: string;
  /** Authoritative amount this payment will be filed for. */
  total: number | undefined;
  /** Fiscal payment type this payment would be filed with. */
  method?: string;
  /** This payment's idempotency key. */
  idempotencyKey: string;
  now?: number;
}): Promise<SittingCheck> {
  const now = input.now ?? Date.now();
  const area = String(input.area || '');
  const tableLabel = String(input.tableLabel || '');
  if (!area || !tableLabel) return { kind: 'clear' };

  const sessionStart = await getTableSessionStartedAt(area, tableLabel).catch(
    () => null,
  );
  const erasedAt = await readLedgerErasedAt(prisma as any).catch(() => null);
  let sinceMs = sessionStart
    ? sessionStart.getTime()
    : now - FALLBACK_LOOKBACK_MS;
  if (erasedAt && erasedAt.getTime() > sinceMs) sinceMs = erasedAt.getTime();

  const currentDocId = input.idempotencyKey
    ? docIdFromKey(input.idempotencyKey, 'invoice')
    : '';

  const rows = (await listFiscalClaimsUpdatedSince(new Date(sinceMs))).filter(
    (row) =>
      row.idempotencyKey !== currentDocId &&
      row.record.context?.area === area &&
      row.record.context?.tableLabel === tableLabel &&
      createdAtMs(row.record) >= sinceMs &&
      (row.record.state === 'PENDING' ||
        row.record.state === 'UNKNOWN' ||
        row.record.state === 'REGISTERED'),
  );
  if (rows.length === 0) return { kind: 'clear' };

  const recorded = await recordedSaleKeys(rows.flatMap(saleKeysOf));
  const open = rows
    .filter((row) => !isRecorded(row, recorded))
    .sort((a, b) => createdAtMs(b.record) - createdAtMs(a.record));
  if (open.length === 0) return { kind: 'clear' };

  const label = where(area, tableLabel);
  const total = Number(input.total);
  let adoptable: ClaimRow | null = null;
  let blocker: SittingCheck | null = null;

  for (const row of open) {
    const { record } = row;
    if (record.state === 'PENDING') {
      if (isDeadPendingClaim(record, now)) {
        await surfaceDeadPending(row);
        blocker ??= unresolved(row, label);
      } else if (!blocker) {
        blocker = {
          kind: 'blocked',
          code: 'FISCAL_SITTING_BUSY',
          message: `An earlier payment for ${label} is being sent to fiskalizimi right now. Wait a minute and try again.`,
          docId: row.idempotencyKey,
          retryable: true,
        };
      }
      continue;
    }
    if (record.state === 'UNKNOWN') {
      blocker ??= unresolved(row, label);
      continue;
    }
    // REGISTERED with no saved sale.
    const filedTotal = Number(record.context?.total);
    const sameAmount =
      Number.isFinite(total) &&
      Number.isFinite(filedTotal) &&
      Math.abs(filedTotal - total) < SAME_TOTAL_EPSILON;
    // Older claims did not record the method; for those the amount decides.
    const filedMethod = String(record.context?.method || '').trim();
    const sameMethod =
      !filedMethod || !input.method || filedMethod === input.method;
    if (sessionStart && sameAmount && sameMethod && !adoptable) {
      adoptable = row;
      continue;
    }
    await flagOrphan(row, now).catch(() => undefined);
    blocker ??= {
      kind: 'blocked',
      code: 'FISCAL_SITTING_UNRESOLVED',
      message:
        `An invoice was already filed for ${label} (NIVF ${record.result?.nivf || '—'}, total ${money(filedTotal)}${filedMethod ? `, ${filedMethod}` : ''}) but the sale was never saved,` +
        ` and it does not match this payment (${money(total)}${input.method ? `, ${input.method}` : ''}). To avoid a second invoice this payment is on hold:` +
        ` cancel that invoice in easyPos, then mark it resolved in Settings › Fiskalizimi (docId ${row.idempotencyKey}).`,
      docId: row.idempotencyKey,
      retryable: false,
    };
  }

  if (blocker) return blocker;
  if (adoptable) {
    return {
      kind: 'adopt',
      docId: adoptable.idempotencyKey,
      nivf: adoptable.record.result?.nivf,
    };
  }
  return { kind: 'clear' };
}

function unresolved(row: ClaimRow, label: string): SittingCheck {
  return {
    kind: 'blocked',
    code: 'FISCAL_SITTING_UNRESOLVED',
    message:
      `An earlier payment for ${label} may already have been reported to fiskalizimi, but easyPos never confirmed it (docId ${row.idempotencyKey}).` +
      ' To avoid filing the sale twice this payment is on hold. An admin must check that docId in easyPos and resolve it in Settings › Fiskalizimi.',
    docId: row.idempotencyKey,
    retryable: false,
  };
}

/**
 * Point a filed invoice at the payment that is reusing it, and tell admins.
 * Call before saving the sale so the claim and the sale stay linked.
 */
export async function adoptFiscalInvoice(input: {
  docId: string;
  saleKey: string;
  area: string;
  tableLabel: string;
  nivf?: string;
  actorUserId?: number;
}): Promise<void> {
  await withFiscalClaimLock(input.docId, () =>
    annotateFiscalClaimUnlocked(input.docId, {
      saleKey: input.saleKey,
      orphanDetectedAt: undefined,
    }),
  );
  await notifyAdminsAndActor({
    message:
      `Payment on ${where(input.area, input.tableLabel)} reused invoice NIVF ${input.nivf || '—'},` +
      ' which had been filed before the till lost the sale. No second invoice was filed' +
      ` · docId ${input.docId}.`,
    actorUserId: input.actorUserId,
    type: 'SECURITY',
  }).catch(() => undefined);
}

let lastSweepAt = 0;

/**
 * Surface fiscal problems nobody is retrying:
 *
 *   - a PENDING claim whose send was interrupted becomes UNKNOWN, so it is
 *     on the review list instead of silently holding a possibly-filed
 *     invoice;
 *   - a filed invoice with no saved sale after `ORPHAN_GRACE_MS` is flagged
 *     for review; the flag is cleared once a sale is saved against it.
 *
 * Throttled; runs from the deferred-transmit loop and once at start-up.
 */
export async function sweepFiscalClaims(options?: {
  force?: boolean;
  now?: number;
}): Promise<{ interrupted: number; orphans: number }> {
  const now = options?.now ?? Date.now();
  if (!options?.force && now - lastSweepAt < SWEEP_INTERVAL_MS) {
    return { interrupted: 0, orphans: 0 };
  }
  lastSweepAt = now;

  const erasedAt = await readLedgerErasedAt(prisma as any).catch(() => null);
  const rows = (
    await listFiscalClaimsUpdatedSince(new Date(now - SWEEP_WINDOW_MS))
  ).filter((row) => !erasedAt || createdAtMs(row.record) >= erasedAt.getTime());

  let interrupted = 0;
  for (const row of rows) {
    if (!isDeadPendingClaim(row.record, now)) continue;
    if (isFiscalClaimLocked(row.idempotencyKey)) continue;
    if (await surfaceDeadPending(row)) interrupted += 1;
  }

  const filed = rows.filter(
    (row) =>
      row.record.state === 'REGISTERED' &&
      (row.record.orphanDetectedAt ||
        now - createdAtMs(row.record) >= ORPHAN_GRACE_MS),
  );
  const recorded = await recordedSaleKeys(filed.flatMap(saleKeysOf));
  let orphans = 0;
  for (const row of filed) {
    if (isRecorded(row, recorded)) {
      if (row.record.orphanDetectedAt) {
        await withFiscalClaimLock(row.idempotencyKey, () =>
          annotateFiscalClaimUnlocked(row.idempotencyKey, {
            orphanDetectedAt: undefined,
          }),
        ).catch(() => undefined);
      }
      continue;
    }
    if (isFiscalClaimLocked(row.idempotencyKey)) continue;
    if (!row.record.orphanDetectedAt) {
      await flagOrphan(row, now).catch(() => undefined);
      orphans += 1;
    }
  }
  return { interrupted, orphans };
}

/** Test seam. */
export function __resetFiscalSweepForTests(): void {
  lastSweepAt = 0;
}
