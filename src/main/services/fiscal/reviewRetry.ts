/**
 * "Not in easyPos — send again" from the fiscal review list.
 *
 * This used to mark the claim FAILED and nothing else: no lock, no check.
 * After a 20 s timeout the invoice had in fact been filed, the reviewer
 * pressed retry, and the next send filed the same sale a second time (QA
 * v0.2.103, H2: S66 and S67 got two invoices each). Now:
 *
 *   - one retry per sale at a time: it runs under the claim lock that the
 *     payment path and the transmit loop also take, and a second click while
 *     one is running is told so instead of queueing behind it;
 *   - cloud API: easyPos is asked first (POST /invoice/status with the same
 *     docId). Filed → its NIVF is recorded and nothing is sent. Never seen →
 *     the stored invoice is queued under the SAME docId, still checked again
 *     before it goes out. No answer → nothing changes;
 *   - local middleware: it cannot be asked, so the reviewer must confirm
 *     they looked the docId up in easyPos. Without that, nothing is sent.
 */
import type { SettingsDTO } from '@shared/ipc';
import {
  FiscalClaimBusyError,
  readFiscalClaim,
  releaseReviewedClaimUnlocked,
  requeueReviewedClaimUnlocked,
  resolveFiscalClaim,
  withFiscalClaimLock,
} from './claims';
import { fiscalConfig } from './config';
import { checkFiscalDocStatus } from './easypos';

export type FiscalReviewRetryResult =
  | {
      ok: true;
      /** queued: sent by the transmit loop shortly. filed: already in easyPos. released: the parked payment can be sent again. */
      outcome: 'queued' | 'filed' | 'released';
      nivf?: string;
    }
  | {
      ok: false;
      code:
        | 'NOT_FOUND'
        | 'BUSY'
        | 'CONFIRM_REQUIRED'
        | 'STATUS_UNKNOWN'
        | 'NOT_RETRYABLE';
      error: string;
    };

/** How long a retry waits for another sequence on the same sale. */
const RETRY_LOCK_WAIT_MS = 1_000;

export async function retryFiscalReview(input: {
  idempotencyKey: string;
  settings: SettingsDTO;
  /** The reviewer looked this docId up in easyPos and it is not there. */
  confirmedNotFiled?: boolean;
  /** Test seam. */
  checkStatus?: typeof checkFiscalDocStatus;
  /** Stamp NIVF/NSLF on the recorded sale once the invoice is known. */
  stampSale?: (saleKey: string, result: any) => Promise<void>;
}): Promise<FiscalReviewRetryResult> {
  const key = String(input.idempotencyKey || '').trim();
  const checkStatus = input.checkStatus ?? checkFiscalDocStatus;
  try {
    return await withFiscalClaimLock(
      key,
      async (): Promise<FiscalReviewRetryResult> => {
        const claim = await readFiscalClaim(key);
        if (!claim) {
          return { ok: false, code: 'NOT_FOUND', error: 'claim not found' };
        }
        const reviewable =
          claim.state === 'UNKNOWN' ||
          (claim.state === 'DEFERRED' && Boolean(claim.holdReason));
        if (!reviewable) {
          return {
            ok: false,
            code: 'NOT_RETRYABLE',
            error:
              claim.state === 'REGISTERED' ||
              claim.state === 'CORRECTION_REQUIRED' ||
              claim.state === 'CORRECTED'
                ? `docId ${key} is already filed with easyPos; it is never sent again.`
                : `docId ${key} is not waiting for review (state ${claim.state}).`,
          };
        }
        // An invoice CIS already answered for is never sent again.
        if (String(claim.result?.nivf || '').trim()) {
          return {
            ok: false,
            code: 'NOT_RETRYABLE',
            error: `docId ${key} already has NIVF ${claim.result?.nivf}. Choose "Found in easyPos" instead.`,
          };
        }
        const cloud = fiscalConfig(input.settings).cloud;
        if (cloud) {
          const status = await checkStatus(input.settings, key, claim.draft);
          if (status.kind === 'filed') {
            const result = {
              nslf: status.result.nslf || undefined,
              nivf: status.result.nivf || undefined,
              eic: status.result.eic || undefined,
              link: status.result.link || undefined,
              qrCode: status.result.qrCode || undefined,
              ...(status.result.doc ? { doc: status.result.doc } : {}),
              status: 'accepted' as const,
            };
            await resolveFiscalClaim(key, 'registered', result);
            const saleKey = String(claim.context?.saleKey || '').trim() || key;
            await input.stampSale?.(saleKey, result).catch(() => undefined);
            return { ok: true, outcome: 'filed', nivf: result.nivf };
          }
          if (status.kind === 'unknown') {
            return {
              ok: false,
              code: 'STATUS_UNKNOWN',
              error: `easyPos could not say whether docId ${key} is filed, so nothing was sent. Try again when easyPos answers. ${status.message}`,
            };
          }
        } else if (input.confirmedNotFiled !== true) {
          return {
            ok: false,
            code: 'CONFIRM_REQUIRED',
            error: `Look up docId ${key} in easyPos first. The local easyPos middleware cannot be asked, and sending an invoice it already filed files the sale twice.`,
          };
        }
        const note = cloud
          ? 'easyPos had no invoice for this docId; queued to be sent again from the review list.'
          : 'An admin confirmed easyPos has no invoice for this docId; queued to be sent again from the review list.';
        // Cloud: still ask once more before the send itself. Local: the
        // middleware cannot be asked, and a person has just checked.
        const opts = { checkStatusFirst: cloud, note };
        if (claim.draft != null) {
          const queued = await requeueReviewedClaimUnlocked(key, opts);
          if (queued) return { ok: true, outcome: 'queued' };
          return {
            ok: false,
            code: 'NOT_RETRYABLE',
            error: `docId ${key} could not be put back on the queue. Try again.`,
          };
        }
        await releaseReviewedClaimUnlocked(key, opts);
        return { ok: true, outcome: 'released' };
      },
      RETRY_LOCK_WAIT_MS,
    );
  } catch (e) {
    if (e instanceof FiscalClaimBusyError) {
      return {
        ok: false,
        code: 'BUSY',
        error: `docId ${key} is being sent or retried right now. Wait for that to finish; it is never sent twice in parallel.`,
      };
    }
    throw e;
  }
}
