/**
 * The register / status / replay recovery sequence.
 *
 *   a. POST /invoice/register
 *   b. ambiguous or incomplete → exponential backoff with jitter, ≤30s
 *   c. POST /invoice/status with the SAME docId
 *   d. status says "not found" → replay /invoice/register with the exact
 *      same docId and the exact same body
 *   e. register and status are never in flight together for one docId
 *   f. 400s and cisError env:CLIENT are never retried
 *   g. env:SERVER, otherError, timeouts, 502/503 and "another request is
 *      processing" are
 *
 * The rule that makes it safe is (d): a replay is permitted *only* after
 * the provider has told us it has never heard of the docId. Every other
 * ambiguous state polls again or gives up to a human. Re-POSTing on a
 * timeout without that confirmation is the classic way one sale becomes
 * two tax documents, and it is what the previous code did for 502/503/504
 * before registration was excluded from retries altogether — which then
 * traded duplicates for silent unresolved sales, because nothing ever
 * checked the status.
 *
 * The body is never rebuilt between attempts. Callers hand in one frozen
 * request object and it is sent byte-for-byte every time, so a replay
 * cannot drift (a regenerated timestamp or a re-read exchange rate would
 * make the provider treat it as a different document).
 */

import type { SettingsDTO } from '@shared/ipc';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffDelayMs,
  defaultSleep,
  type Sleep,
} from './backoff';
import {
  classifyFiscalAttempt,
  isNotFoundStatus,
  type FiscalClassification,
} from './classify';
import {
  FiscalTransportError,
  postCancelInvoice,
  postInvoiceStatus,
  postRegisterInvoice,
  withDocIdLock,
  type FiscalHttpResult,
} from './client';
import {
  assessCompletion,
  targetForInvoice,
  type CompletionTarget,
  type FiscalIdentifiers,
} from './completion';
import { fiscalConfig, type FiscalEnvironment } from './config';
import {
  FiscalValidationError,
  validateCancelInvoice,
  validateRegisterInvoice,
  type ValidationIssue,
} from './validate';
import type { CancelInvoiceRequest, RegisterInvoiceRequest } from './apiTypes';

export type RecoveryPhase = 'register' | 'status' | 'replay' | 'cancel';

export interface RecoveryEvent {
  phase: RecoveryPhase;
  attempt: number;
  message: string;
  delayMs?: number;
}

export interface RecoveryOptions {
  /** Defaults to the contract implied by `isEinvoice` on the request. */
  target?: CompletionTarget;
  /** Total POSTs of the document route, initial attempt included. */
  maxSendAttempts?: number;
  /** Total `/invoice/status` polls. */
  maxStatusPolls?: number;
  /** Wall-clock budget. Past it, unresolved work goes to a human. */
  deadlineMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /**
   * Renew the access token for this environment and return the new one.
   * Returning null/undefined means renewal is not possible.
   */
  onTokenRenew?: (
    environment: FiscalEnvironment,
  ) => Promise<string | null | undefined>;
  onEvent?: (event: RecoveryEvent) => void;
  /** Test seams. */
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
}

export type RecoveryResult =
  /** The document exists upstream and the completion contract is satisfied. */
  | {
      kind: 'complete';
      docId: string;
      identifiers: FiscalIdentifiers;
      /** Which call produced the confirmation. */
      via: 'register' | 'status' | 'replay';
      sendAttempts: number;
      statusPolls: number;
      raw: unknown;
    }
  /**
   * Nothing was filed and nothing will be until the request or the
   * configuration changes.
   */
  | {
      kind: 'rejected';
      docId: string;
      message: string;
      sendAttempts: number;
      statusPolls: number;
    }
  /** Nothing was filed. The same docId may be sent again later. */
  | {
      kind: 'not-registered';
      docId: string;
      message: string;
      sendAttempts: number;
      statusPolls: number;
    }
  /**
   * We could not establish whether the document exists. Never retried
   * automatically — a person has to look up the docId in easyPos.
   */
  | {
      kind: 'unresolved';
      docId: string;
      message: string;
      sendAttempts: number;
      statusPolls: number;
    };

const DEFAULT_MAX_SEND_ATTEMPTS = 3;
const DEFAULT_MAX_STATUS_POLLS = 4;
/**
 * A till cannot hold the guest at the card machine indefinitely. Past this,
 * the claim record and the review queue carry the sale instead — which is
 * the correct place for an unresolved document anyway.
 */
const DEFAULT_DEADLINE_MS = 90_000;
const MAX_TOKEN_RENEWALS = 1;

interface Attempt {
  source: 'register' | 'status' | 'cancel';
  result?: FiscalHttpResult;
  error?: unknown;
}

function classifyAttempt(
  attempt: Attempt,
  target: CompletionTarget,
): { classification: FiscalClassification; identifiers: FiscalIdentifiers } {
  if (attempt.error || !attempt.result) {
    return {
      classification: classifyFiscalAttempt({ error: attempt.error }),
      identifiers: {},
    };
  }
  const { httpStatus, data } = attempt.result;
  const verdict = assessCompletion(target, data);
  return {
    classification: classifyFiscalAttempt({
      httpStatus,
      data,
      incomplete: !verdict.complete,
      incompleteReason: verdict.complete ? undefined : verdict.reason,
    }),
    identifiers: verdict.identifiers,
  };
}

/**
 * Drive one document to a confirmed outcome.
 *
 * `send` is invoked for the initial attempt and for any replay, and must
 * send the identical body each time — it takes only the token so it cannot
 * be tempted to rebuild the payload.
 */
async function driveRecovery(input: {
  settings: SettingsDTO;
  docId: string;
  target: CompletionTarget;
  sendPhase: 'register' | 'cancel';
  send: (authToken?: string) => Promise<FiscalHttpResult>;
  options?: RecoveryOptions;
}): Promise<RecoveryResult> {
  const { settings, docId, target, send, sendPhase } = input;
  const options = input.options || {};
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random;
  const maxSendAttempts = Math.max(
    1,
    options.maxSendAttempts ?? DEFAULT_MAX_SEND_ATTEMPTS,
  );
  const maxStatusPolls = Math.max(
    0,
    options.maxStatusPolls ?? DEFAULT_MAX_STATUS_POLLS,
  );
  const deadlineMs = Math.max(0, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const backoffOptions = {
    baseMs: options.backoffBaseMs ?? BACKOFF_BASE_MS,
    capMs: options.backoffCapMs ?? BACKOFF_CAP_MS,
    ...(random ? { random } : {}),
  };
  const startedAt = now();
  const outOfTime = () => deadlineMs > 0 && now() - startedAt >= deadlineMs;

  let sendAttempts = 0;
  let statusPolls = 0;
  let backoffStep = 0;
  let renewals = 0;
  let authToken: string | undefined;
  let lastMessage = 'Fiscalization did not complete.';

  const emit = (phase: RecoveryPhase, message: string, delayMs?: number) => {
    options.onEvent?.({ phase, attempt: sendAttempts, message, delayMs });
  };

  const doSend = async (phase: RecoveryPhase): Promise<Attempt> => {
    sendAttempts++;
    emit(phase, `POST ${sendPhase} attempt ${sendAttempts} for docId ${docId}`);
    try {
      return { source: sendPhase, result: await send(authToken) };
    } catch (e) {
      return { source: sendPhase, error: e };
    }
  };

  const doStatus = async (): Promise<Attempt> => {
    statusPolls++;
    emit(
      'status',
      `POST /invoice/status poll ${statusPolls} for docId ${docId}`,
    );
    try {
      return {
        source: 'status',
        result: await postInvoiceStatus(settings, { docId }, { authToken }),
      };
    } catch (e) {
      return { source: 'status', error: e };
    }
  };

  const wait = async (): Promise<void> => {
    backoffStep++;
    const delay = backoffDelayMs(backoffStep, backoffOptions);
    emit('status', `Waiting ${delay}ms before checking status`, delay);
    await sleep(delay);
  };

  let attempt = await doSend(sendPhase);

  for (;;) {
    const { classification } = classifyAttempt(attempt, target);

    // A completed document ends everything, whichever call reported it.
    if (attempt.result) {
      const verdict = assessCompletion(target, attempt.result.data);
      if (verdict.complete) {
        return {
          kind: 'complete',
          docId,
          identifiers: verdict.identifiers,
          via:
            attempt.source === 'status'
              ? 'status'
              : sendAttempts > 1
                ? 'replay'
                : 'register',
          sendAttempts,
          statusPolls,
          raw: attempt.result.data,
        };
      }
    }

    lastMessage = classification.message;

    // (f) Nothing a retry can fix.
    if (classification.action === 'fix-request') {
      if (attempt.source === 'status') {
        // The status route itself refused the question. That tells us
        // nothing about the document, so we must not conclude it is absent.
        return {
          kind: 'unresolved',
          docId,
          message: `Could not determine the status of docId ${docId}: ${classification.message}`,
          sendAttempts,
          statusPolls,
        };
      }
      return {
        kind: 'rejected',
        docId,
        message: classification.message,
        sendAttempts,
        statusPolls,
      };
    }

    // 401/403: renew for the right environment, then repeat the same call
    // with the same docId and body.
    if (classification.action === 'renew-token') {
      const environment = fiscalConfig(settings).environment;
      if (renewals >= MAX_TOKEN_RENEWALS || !options.onTokenRenew) {
        return {
          kind: 'not-registered',
          docId,
          message: classification.message,
          sendAttempts,
          statusPolls,
        };
      }
      renewals++;
      const renewed = await options.onTokenRenew(environment).catch(() => null);
      if (!renewed) {
        return {
          kind: 'not-registered',
          docId,
          message: `${classification.message} Renewing the ${environment} token failed.`,
          sendAttempts,
          statusPolls,
        };
      }
      authToken = renewed;
      emit(
        attempt.source === 'status' ? 'status' : sendPhase,
        `Renewed ${environment} token`,
      );
      attempt =
        attempt.source === 'status'
          ? await doStatus()
          : await doSend(sendPhase);
      continue;
    }

    // Proven never to have reached the provider (connection refused, DNS,
    // rate limit). Safe to send the same docId again without a status check.
    if (
      classification.action === 'retry' &&
      classification.outcome === 'not-registered'
    ) {
      if (sendAttempts >= maxSendAttempts || outOfTime()) {
        return {
          kind: 'not-registered',
          docId,
          message: classification.message,
          sendAttempts,
          statusPolls,
        };
      }
      await wait();
      attempt = await doSend(sendPhase);
      continue;
    }

    // (b)(c) Ambiguous: back off, then ask what happened.
    if (statusPolls >= maxStatusPolls || outOfTime()) {
      return {
        kind: 'unresolved',
        docId,
        message: `${lastMessage} The document's status could not be confirmed within the recovery budget; docId ${docId} must be checked in easyPos before this sale is sent again.`,
        sendAttempts,
        statusPolls,
      };
    }

    await wait();
    const status = await doStatus();

    if (status.result) {
      const verdict = assessCompletion(target, status.result.data);
      if (verdict.complete) {
        return {
          kind: 'complete',
          docId,
          identifiers: verdict.identifiers,
          via: 'status',
          sendAttempts,
          statusPolls,
          raw: status.result.data,
        };
      }
      // (d) The only safe green light for a replay.
      if (
        isNotFoundStatus({
          httpStatus: status.result.httpStatus,
          data: status.result.data,
        })
      ) {
        if (sendAttempts >= maxSendAttempts || outOfTime()) {
          return {
            kind: 'not-registered',
            docId,
            message: `easyPos has no record of docId ${docId}, but the recovery budget is spent. ${lastMessage}`,
            sendAttempts,
            statusPolls,
          };
        }
        emit(
          'replay',
          `easyPos has no record of docId ${docId}; replaying the identical request`,
        );
        attempt = await doSend('replay');
        continue;
      }
    }

    // Status was itself inconclusive. Loop: classify it, back off, ask again.
    attempt = status;
  }
}

/** Freeze the request so no attempt can mutate what a replay must resend. */
function freezeRequest<T extends object>(request: T): T {
  return Object.freeze({ ...request }) as T;
}

/**
 * The single gate every outbound document passes through.
 *
 * Client-side validation only pays for itself if nothing can go around it,
 * and until now something could: the builders in `buildInvoice.ts` each
 * called `assertValidRegisterInvoice`, but the path every real sale takes
 * — `mapInvoice.ts` → `createEasyPosSale` → here — assembles its request
 * by hand and never touched them. So the rules were enforced for the
 * document types the POS does not file and skipped for the one it does.
 *
 * Validating here instead of at each builder also puts the check after the
 * body is frozen, which is the only place it can speak for what will
 * actually be sent, replays included.
 *
 * A failure is `rejected`, never `unresolved`: nothing left the machine, so
 * the docId is still unused and the sale is safe to send again once the
 * data is fixed.
 */
function rejectedByValidation(
  docId: string,
  issues: ValidationIssue[],
): RecoveryResult {
  return {
    kind: 'rejected',
    docId,
    message: new FiscalValidationError(issues).message,
    sendAttempts: 0,
    statusPolls: 0,
  };
}

/**
 * Register an invoice, recovering through `/invoice/status` when the
 * outcome is ambiguous.
 *
 * The whole sequence holds the docId lock, so a concurrent attempt on the
 * same document queues behind it and then observes the settled result
 * instead of racing it.
 */
export function registerInvoiceWithRecovery(
  settings: SettingsDTO,
  request: RegisterInvoiceRequest,
  options?: RecoveryOptions,
): Promise<RecoveryResult> {
  const frozen = freezeRequest(request);
  const docId = String(frozen.docId || '').trim();
  const target = options?.target ?? targetForInvoice(frozen);
  const issues = validateRegisterInvoice(frozen);
  if (issues.length) {
    return Promise.resolve(rejectedByValidation(docId, issues));
  }
  return withDocIdLock(docId, () =>
    driveRecovery({
      settings,
      docId,
      target,
      sendPhase: 'register',
      send: (authToken) => postRegisterInvoice(settings, frozen, { authToken }),
      options,
    }),
  );
}

/**
 * Cancel an invoice, recovering the same way.
 *
 * A cancellation is its own business document with its own new docId, so
 * `/invoice/status` for that docId answers whether the cancellation was
 * filed — not whether the original invoice was.
 */
export function cancelInvoiceWithRecovery(
  settings: SettingsDTO,
  request: CancelInvoiceRequest,
  options?: RecoveryOptions,
): Promise<RecoveryResult> {
  const frozen = freezeRequest(request);
  const docId = String(frozen.docId || '').trim();
  const target = options?.target ?? targetForInvoice(frozen);
  const issues = validateCancelInvoice(frozen);
  if (issues.length) {
    return Promise.resolve(rejectedByValidation(docId, issues));
  }
  return withDocIdLock(docId, () =>
    driveRecovery({
      settings,
      docId,
      target,
      sendPhase: 'cancel',
      send: (authToken) => postCancelInvoice(settings, frozen, { authToken }),
      options,
    }),
  );
}

export { FiscalTransportError };
