import type { SettingsDTO } from '@shared/ipc';
import type { TicketPrintPayload } from '../../print';
import { buildEasyPosInvoiceDraft, type DraftAdjustment } from './mapInvoice';
import {
  assertFiscalConfigured,
  createEasyPosSale,
  fiscalOutcomeOf,
  isFiscalRetryable,
  testEasyPosConnection,
} from './easypos';
import { docIdFromKey } from './docId';
import {
  ensureDailyBalanceForCash,
  isBalanceSettled,
  markDailyBalanceAlerted,
} from './balance';
import { fiscalConfig } from './config';
import { mapPaymentMethod } from './paymentMethod';
import { notifyAdminsAndActor } from '../adminAlerts';
import { getTableSessionStartedAt } from '../tableSession';
import {
  claimFiscalRegistration,
  findRegisteredClaimForTable,
  flagFiscalCorrectionRequired,
  notifyFiscalReviewNeeded,
  settleFiscalClaimFailed,
  settleFiscalClaimRegistered,
  settleFiscalClaimUnknown,
  type StoredFiscalResult,
} from './claims';

export {
  testEasyPosConnection,
  getFiscalTokenHint,
  testMinimalCloudInvoice,
} from './easypos';

export {
  listFiscalClaimsNeedingReview,
  readFiscalClaim,
  resolveFiscalClaim,
} from './claims';

export function isFiscalEnabled(settings: SettingsDTO): boolean {
  return (settings as any)?.fiscal?.enabled === true;
}

export type FiscalizeOutcome =
  /** Safe to print and record. Payload carries any fiscal identifiers. */
  | { kind: 'ok'; payload: TicketPrintPayload; replayed?: boolean }
  /** Nothing was filed, and a later attempt has a real chance. */
  | { kind: 'retryable'; message: string }
  /**
   * Nothing was filed and nothing will be until someone changes the
   * configuration or the invoice data — a bad article id, an unknown
   * operator code, a missing exchange rate. Retrying is pure noise.
   */
  | { kind: 'rejected'; message: string }
  /**
   * We cannot tell whether an invoice was filed. Retrying could register
   * the same sale twice, so a human must reconcile against easyPos first.
   */
  | { kind: 'needs-review'; message: string };

/** A cent is rounding. More than that is a real disagreement. */
const ADJUSTMENT_ALERT_THRESHOLD = 0.05;

/**
 * The invoice we are about to file does not add up to the amount charged,
 * so a balancing line was added at the default VAT rate. The document will
 * be accepted and the totals will be right, but on a mixed-VAT ticket the
 * breakdown filed with the tax service is now wrong. That is not something
 * to discover during an inspection.
 */
async function reportDraftAdjustment(
  info: DraftAdjustment,
  payload: TicketPrintPayload,
): Promise<void> {
  const where = [
    String((payload as any).area || ''),
    String((payload as any).tableLabel || ''),
  ]
    .filter(Boolean)
    .join(' ');
  const detail =
    `Fiscal invoice needed a ${info.difference.toFixed(2)} balancing line` +
    `${where ? ` on ${where}` : ''}: line items total ${info.articleTotal.toFixed(2)} ` +
    `but the amount charged was ${info.targetTotal.toFixed(2)}.`;
  console.warn(`[fiscal] ${detail}`);
  if (Math.abs(info.difference) < ADJUSTMENT_ALERT_THRESHOLD) return;
  await notifyAdminsAndActor({
    message: `${detail} The adjustment was filed at VAT band ${info.vatCode}, so the VAT breakdown may not match the receipt.`,
    actorUserId: Number((payload.meta as any)?.userId || 0) || undefined,
    type: 'SECURITY',
  }).catch(() => undefined);
}

function withFiscalMeta(
  payload: TicketPrintPayload,
  result: StoredFiscalResult,
): TicketPrintPayload {
  return {
    ...payload,
    meta: {
      ...(payload.meta || {}),
      fiscalEnabled: true,
      fiscalNslf: result.nslf || undefined,
      fiscalNivf: result.nivf || undefined,
      fiscalEic: result.eic || undefined,
      fiscalLink: result.link || undefined,
      fiscalWarning: result.warning || undefined,
      fiscalStatus: result.status,
    },
  };
}

/**
 * Declare today's opening cash float, if this is a cash sale and it has
 * not been declared yet.
 *
 * The tax service wants `POST /balance/initiate` once per business day per
 * fiscal device, before that day's first cash invoice. Skip it and cash
 * invoices come back with the "daily balance not reported" fault — filed
 * with an NSLF and no NIVF, which is to say not registered at all. Until
 * now the machinery for this existed and nothing called it, so the rule
 * was enforced by staff remembering to declare the float by hand in
 * easyPos; the code merely recognised the fault afterwards and printed a
 * note asking them to go and do it.
 *
 * Three deliberate limits.
 *
 * It never blocks the sale. A local record is not proof of what the tax
 * service holds — the float may have been declared in easyPos directly, or
 * by another till on the same device, or our record may simply have been
 * lost — so refusing to file the invoice on the strength of it would
 * reject sales that would have gone through. The register call is the
 * authority; if the balance really is missing, it says so, and
 * `resultFromResponse` already turns that fault into the right message.
 *
 * It only applies to the cloud API. The local middleware has no balance
 * routes at all.
 *
 * It alerts admins at most once per day. The check runs on every cash
 * sale, and an alert per sale is an alert nobody reads.
 */
async function ensureCashBalanceDeclared(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  meta: any,
): Promise<void> {
  try {
    if (!fiscalConfig(settings).cloud) return;
    const method = mapPaymentMethod(
      String(meta.method || meta.paymentMethod || 'CASH'),
    );
    if (method !== 'CASH') return;

    const configured = Number((settings as any)?.fiscal?.openingFloat);
    const openingFloat =
      Number.isFinite(configured) && configured >= 0 ? configured : 0;

    const outcome = await ensureDailyBalanceForCash(settings, { openingFloat });
    if (isBalanceSettled(outcome)) return;

    console.warn(
      `[fiscal] Opening cash balance not declared for today: ${outcome.message}`,
    );
    if (!(await markDailyBalanceAlerted(settings))) return;
    await notifyAdminsAndActor({
      message:
        `Today's opening cash balance could not be declared to fiskalizimi, so cash invoices may be refused: ${outcome.message}` +
        ' · Check the opening float in Settings › Fiskalizimi, then take a cash payment to retry.',
      actorUserId: Number(meta.userId || 0) || undefined,
      type: 'SECURITY',
    }).catch(() => undefined);
  } catch (e: any) {
    // A balance problem must never be the reason a payment fails.
    console.warn(
      `[fiscal] Could not check today's opening cash balance: ${String(e?.message || e)}`,
    );
  }
}

/**
 * Fiscalize a payment at most once, whatever happens to the caller.
 *
 * Registering an invoice is an irreversible side effect on a remote tax
 * service, and three separate things retry a payment: the HTTP layer
 * inside `easyPosRequest`, the renderer's offline queue, and a tablet
 * whose request timed out. A durable claim is taken BEFORE the request so
 * all three converge on one invoice instead of one each.
 *
 * The claim also holds NSLF/NIVF, so a later failure to write the
 * `PrintJob` audit row can no longer lose the only local trace of an
 * invoice the tax service has already accepted.
 *
 * Both transports (Electron IPC and the LAN HTTP API) must call this
 * rather than talking to easyPos directly — the original duplicate-invoice
 * gap came from the two paths drifting apart.
 */
export async function fiscalizePaymentOnce(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  options?: { idempotencyKey?: string },
): Promise<FiscalizeOutcome> {
  const kind = String(payload.meta?.kind || '').toUpperCase();
  if (kind !== 'PAYMENT' || !isFiscalEnabled(settings)) {
    return { kind: 'ok', payload };
  }

  const idempotencyKey = String(options?.idempotencyKey || '').trim();
  const meta: any = payload.meta || {};
  const area = String((payload as any).area || '') || undefined;
  const tableLabel = String((payload as any).tableLabel || '') || undefined;

  /**
   * The docId for this sale, decided before anything is built or sent.
   *
   * A client that sends an idempotency key gets that key as its docId, so
   * the docId matches what the rest of the POS stores and searches by.
   *
   * A client that sends none is refused. Minting one here looks harmless
   * and is the exact duplicate-invoice bug this module is built to prevent:
   * a docId invented per attempt is a docId nothing has stored, so the
   * second attempt takes a *different* claim, `/invoice/status` for it is
   * guaranteed to answer "not found", and the sale is filed twice. There is
   * no recovery from that except a corrective invoice, and nothing surfaces
   * it until an audit. Both first-party transports already send a key
   * generated once per waiter tap, so this only rejects a client that
   * cannot be replayed safely in the first place.
   */
  let docId: string;
  try {
    if (!idempotencyKey) {
      throw new Error(
        'This payment arrived without an idempotency key, so a repeat of it could not be told apart from a new sale. Fiskalizimi was not attempted rather than risk filing the invoice twice — the client must send an idempotencyKey generated once per payment.',
      );
    }
    docId = docIdFromKey(idempotencyKey, 'invoice');
  } catch (e: any) {
    return { kind: 'rejected', message: String(e?.message || e) };
  }

  /**
   * Every indeterminate outcome must reach an admin, not just a log — but
   * only once, however many times the payment is replayed.
   */
  const review = async (
    message: string,
    alreadyReported = false,
  ): Promise<FiscalizeOutcome> => {
    if (!alreadyReported) {
      await notifyFiscalReviewNeeded({
        idempotencyKey: docId,
        area,
        tableLabel,
        actorUserId: Number(meta.userId || 0) || undefined,
        message,
      }).catch(() => undefined);
    }
    return { kind: 'needs-review', message };
  };

  // Pre-flight. None of this reaches the provider, so a failure here is
  // always safe to retry and must not consume a claim. It is also always a
  // configuration or data problem, so it will not fix itself.
  let draft: ReturnType<typeof buildEasyPosInvoiceDraft>;
  let adjustment: DraftAdjustment | null = null;
  try {
    assertFiscalConfigured(settings);
    const provider = String(
      (settings as any)?.fiscal?.provider || 'easypos',
    ).toLowerCase();
    if (provider !== 'easypos') {
      throw new Error(`Unsupported fiscal provider: ${provider}`);
    }
    draft = buildEasyPosInvoiceDraft(payload, settings, {
      docId,
      onAdjustment: (info) => {
        adjustment = info;
      },
    });
  } catch (e: any) {
    return { kind: 'rejected', message: String(e?.message || e) };
  }

  if (adjustment) await reportDraftAdjustment(adjustment, payload);

  // The tax service refuses a cash invoice until the day's opening float
  // has been declared, so this has to happen before the register call and
  // not after it fails.
  await ensureCashBalanceDeclared(payload, settings, meta);

  /**
   * The draft is frozen here and reused for every attempt, including a
   * replay after a "not found" status. A replay must resend the identical
   * body — rebuilding it could pick up a changed exchange rate or a
   * re-read setting, and the provider would then be looking at a different
   * document under a docId it has already seen.
   */
  Object.freeze(draft);

  let decision: Awaited<ReturnType<typeof claimFiscalRegistration>>;
  try {
    decision = await claimFiscalRegistration(docId, {
      area,
      tableLabel,
      total: Number.isFinite(Number(meta.totalAfter))
        ? Number(meta.totalAfter)
        : undefined,
    });
  } catch (e: any) {
    // No durable claim means nothing would stop a retry from filing a
    // second invoice, so refuse rather than register unprotected.
    return {
      kind: 'retryable',
      message: `Could not record the fiscal claim, so the invoice was not sent: ${String(
        e?.message || e,
      )}`,
    };
  }

  if (decision.outcome === 'replay') {
    return {
      kind: 'ok',
      payload: withFiscalMeta(payload, decision.result),
      replayed: true,
    };
  }
  if (decision.outcome === 'in-flight') {
    return {
      kind: 'retryable',
      message:
        'This payment is already being fiscalized by another attempt. It will finish on its own.',
    };
  }
  if (decision.outcome === 'needs-review') {
    return review(decision.reason, decision.alreadyReported);
  }

  try {
    const result = await createEasyPosSale(settings, draft);
    await settleFiscalClaimRegistered(docId, decision.attemptId, {
      nslf: result.nslf || undefined,
      nivf: result.nivf || undefined,
      eic: result.eic || undefined,
      link: result.link || undefined,
      status: result.status,
      warning: result.warning || undefined,
    }).catch(() => undefined);
    return { kind: 'ok', payload: withFiscalMeta(payload, result) };
  } catch (e: any) {
    const message = String(e?.message || e);
    if (fiscalOutcomeOf(e) === 'not-registered') {
      // FAILED either way: nothing was filed, so the key stays usable once
      // the underlying problem is fixed and an admin releases the payment.
      await settleFiscalClaimFailed(docId, decision.attemptId, message).catch(
        () => undefined,
      );
      if (isFiscalRetryable(e)) return { kind: 'retryable', message };
      await notifyAdminsAndActor({
        message:
          `Fiskalizimi refused this sale and will keep refusing it until it is fixed` +
          `${area || tableLabel ? ` (${[area, tableLabel].filter(Boolean).join(' ')})` : ''}: ${message}`,
        actorUserId: Number(meta.userId || 0) || undefined,
        type: 'SECURITY',
      }).catch(() => undefined);
      return { kind: 'rejected', message };
    }
    await settleFiscalClaimUnknown(docId, decision.attemptId, message).catch(
      () => undefined,
    );
    return review(message);
  }
}

/**
 * How far back to look for the invoice a void is undoing when the table is
 * already closed. Long enough to cover a shift, short enough that it can
 * never reach back to a previous day's business.
 */
const CLOSED_TABLE_LOOKBACK_MS = 12 * 60 * 60 * 1000;

/**
 * Called when a ticket or item is voided, to catch the case where the sale
 * had already been declared to the tax service.
 *
 * A void after fiskalizimi is not a local bookkeeping edit: an invoice
 * exists upstream for money the customer is no longer paying, and only a
 * corrective document filed in easyPos can undo it. This POS cannot issue
 * that, so the least it can do is refuse to let the divergence pass
 * unnoticed. No-ops on the overwhelmingly common case where the table was
 * never fiscalized in this session.
 */
export async function flagVoidAfterFiscalization(input: {
  area: string;
  tableLabel: string;
  reason: string;
  actorUserId?: number;
}): Promise<boolean> {
  if (!input.area || !input.tableLabel) return false;
  try {
    /**
     * Prefer the current session: an invoice filed since the table opened
     * belongs to the ticket being voided, and an older one belongs to a
     * previous party that has nothing to do with this.
     *
     * Taking payment closes the table, though, which clears the session
     * marker — and voiding a paid, closed table is exactly the case worth
     * catching. So when there is no open session, fall back to a bounded
     * lookback: with no ticket in progress, the last invoice filed for
     * this table is the one being undone.
     */
    const since =
      (await getTableSessionStartedAt(input.area, input.tableLabel)) ??
      new Date(Date.now() - CLOSED_TABLE_LOOKBACK_MS);
    const found = await findRegisteredClaimForTable({
      area: input.area,
      tableLabel: input.tableLabel,
      since,
    });
    if (!found) return false;
    return await flagFiscalCorrectionRequired({
      idempotencyKey: found.idempotencyKey,
      reason: input.reason,
      actorUserId: input.actorUserId,
      context: found.record.context,
      result: found.record.result,
    });
  } catch {
    // Never block a void on this bookkeeping check.
    return false;
  }
}

export async function testFiscalConnection(
  settings: SettingsDTO,
): Promise<{ ok: boolean; message?: string; messageKey?: string }> {
  if (!isFiscalEnabled(settings)) {
    return { ok: false, message: 'Fiskalizimi is disabled.' };
  }
  const provider = String(
    (settings as any)?.fiscal?.provider || 'easypos',
  ).toLowerCase();
  if (provider === 'easypos') {
    return testEasyPosConnection(settings);
  }
  return { ok: false, message: `Unsupported fiscal provider: ${provider}` };
}
