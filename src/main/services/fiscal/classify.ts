/**
 * What to do about a failed or incomplete fiscal request.
 *
 * Every branch here is a decision about a remote side effect we cannot
 * undo, so the classification is the whole safety story:
 *
 *   - guess "nothing was filed" when something was, and a retry files the
 *     sale a second time and needs a corrective invoice to unwind;
 *   - guess "something was filed" when nothing was, and the sale is stuck
 *     in a review queue while the guest waits.
 *
 * The mapping follows the spec's error table:
 *
 *   400 validation / field         → fix the request, never retry
 *   401                            → renew the token, retry the same docId
 *   cisError faultEnv=env:CLIENT   → fix the data, never retry
 *   cisError faultEnv=env:SERVER   → retryable
 *   otherError                     → retryable
 *   timeout / connection / 502/503 → check status first, replay only if not found
 *   "another request is processing" → stop, wait, poll status
 */

import type { ApiErrorEnvelope, FiscalApiResponse } from './apiTypes';
import { readFaultText } from './completion';

export type FiscalAction =
  /**
   * The request as written will be refused every time. A human has to
   * change the data or the configuration.
   */
  | 'fix-request'
  /** Credentials expired. Renew for this environment, then retry the same docId. */
  | 'renew-token'
  /** Transient upstream failure. Back off and go through the status check. */
  | 'retry'
  /**
   * We do not know whether the document exists. `/invoice/status` with the
   * same docId is the only way to find out, and a replay is allowed only if
   * it comes back "not found".
   */
  | 'check-status'
  /**
   * The provider is already working on this docId. Sending anything else
   * now is what produces "another request is processing" loops — wait and
   * poll instead.
   */
  | 'wait-and-poll';

/** Whether a failed attempt could have left a real document upstream. */
export type FiscalOutcome = 'not-registered' | 'unknown';

export interface FiscalClassification {
  action: FiscalAction;
  outcome: FiscalOutcome;
  retryable: boolean;
  /** True when the next step must be `/invoice/status`, not another POST. */
  mustCheckStatus: boolean;
  message: string;
}

export interface ClassifyInput {
  /** 0 when there was no HTTP response at all. */
  httpStatus?: number;
  data?: unknown;
  /** The thrown transport error, if the request never produced a response. */
  error?: unknown;
  /** True when a 200 body failed the completion contract. */
  incomplete?: boolean;
  incompleteReason?: string;
}

const CLIENT_ENV = 'env:client';
const SERVER_ENV = 'env:server';

function lower(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function errorEnvelope(data: unknown): ApiErrorEnvelope | undefined {
  return (data as FiscalApiResponse | null)?.error || undefined;
}

/**
 * Text from anywhere in a thrown error, walking the whole `cause` chain.
 *
 * The depth is not incidental. undici reports a refused connection as
 * `Error: fetch failed` with the real `ECONNREFUSED` on `.cause.code`, and
 * `FiscalTransportError` then wraps that — so the code a caller needs sits
 * two levels down. Reading only one level classified a connection that
 * provably never left the machine as an unknown outcome, which sent a
 * perfectly retryable sale to manual review.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++) {
    parts.push(
      String(current.message ?? ''),
      String(current.name ?? ''),
      String(current.code ?? ''),
      String(current.errno ?? ''),
    );
    // Node's `fetch failed` often wraps an AggregateError whose real
    // socket code sits on `.errors[n].code`, not on `.cause`.
    if (Array.isArray(current.errors)) {
      for (const nested of current.errors) {
        parts.push(String(nested?.code ?? ''), String(nested?.message ?? ''));
      }
    }
    current = current.cause;
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Failures that prove the HTTP request was never accepted by easyPos.
 *
 * Only these may claim `not-registered` without a status check. A reset
 * or a timeout after connect can mean the invoice was already on the
 * wire — those stay `unknown`. The ones below never completed a TCP
 * handshake (wifi off, no route, DNS dead, connect timeout), which is
 * what a till sees when the internet is down. Treating them as unknown
 * used to park the sale in review as if an invoice might exist, then
 * refuse to retry it when the network came back.
 */
export function neverReachedProvider(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes('econnrefused') ||
    text.includes('connection refused') ||
    text.includes('err_connection_refused') ||
    text.includes('enotfound') ||
    text.includes('getaddrinfo') ||
    text.includes('eai_again') ||
    text.includes('err_name_not_resolved') ||
    text.includes('enetunreach') ||
    text.includes('enetdown') ||
    text.includes('ehostunreach') ||
    text.includes('ehostdown') ||
    text.includes('network is unreachable') ||
    text.includes('network is down') ||
    text.includes('no route to host') ||
    text.includes('host is unreachable') ||
    text.includes('err_internet_disconnected') ||
    text.includes('err_address_unreachable') ||
    text.includes('err_network_access_denied') ||
    // Connect-phase only. Headers/body timeouts mean the request left.
    text.includes('und_err_connect_timeout') ||
    text.includes('err_connection_timed_out')
  );
}

function isAbort(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes('abort') ||
    text.includes('etimedout') ||
    text.includes('timeout')
  );
}

/**
 * "Another request is processing" — the provider is mid-flight on this
 * docId. Recognised in both languages because the Albanian text is what
 * production actually returns.
 */
export function isAnotherRequestProcessing(data: unknown): boolean {
  const haystack = [
    lower((data as FiscalApiResponse | null)?.message),
    lower(errorEnvelope(data)?.cisError?.faultString),
    lower(errorEnvelope(data)?.otherError?.message),
    lower((data as any)?.response?.text),
  ].join(' | ');
  return (
    (haystack.includes('another request') && haystack.includes('process')) ||
    haystack.includes('request is already being processed') ||
    haystack.includes('request in progress') ||
    (haystack.includes('kerkese') && haystack.includes('proces')) ||
    (haystack.includes('kërkes') && haystack.includes('proces'))
  );
}

/** "Absent" phrasings, in both languages. */
const ABSENT = String.raw`not found|notfound|no such|does not exist|doesn't exist|unknown|nuk gjendet|nuk ekziston|i panjohur`;

/** The thing that is absent has to be the *document*, not some field of it. */
const DOCUMENT = String.raw`document|docid|doc id|dokument|invoice|fature|faturë|receipt`;

/**
 * Entities whose absence says nothing about whether the document exists.
 * An unknown operator code or article is a validation problem with the
 * request, and reading it as "the document does not exist" is precisely
 * how a replay files a second invoice for a sale already registered.
 */
const OTHER_ENTITY =
  /operator|operatori|artikull|artikulli|article|njesia|njësia|unit|token|user|klient|buyer/;

const DOC_ABSENT = new RegExp(
  `(?:${DOCUMENT})[^.;|]{0,40}?(?:${ABSENT})|(?:${ABSENT})[^.;|]{0,40}?(?:${DOCUMENT})`,
);

/** Machine-readable not-found codes, which need no text matching. */
const NOT_FOUND_CODE = /^(?:doc(?:ument)?_?)?not_?found$/;

/**
 * Whether a `/invoice/status` response means "we have never seen this
 * docId" — the one condition that makes replaying a register safe.
 *
 * Deliberately narrow. Every false positive here is a duplicate tax
 * document, so an inconclusive answer must fall through to another poll
 * rather than be read as absence:
 *
 *   - an empty body means "could not tell you", not "does not exist";
 *   - "Operatori nuk gjendet" is about the operator code, not the invoice.
 */
export function isNotFoundStatus(input: {
  httpStatus?: number;
  data?: unknown;
}): boolean {
  if (input.httpStatus === 404) return true;
  const data = input.data as FiscalApiResponse | null;

  const code = lower(errorEnvelope(data)?.otherError?.code).replace(
    /[\s-]/g,
    '_',
  );
  if (code && NOT_FOUND_CODE.test(code)) return true;
  const statusField = lower(data?.status).replace(/[\s-]/g, '_');
  if (statusField && NOT_FOUND_CODE.test(statusField)) return true;

  const messages = [
    lower(data?.message),
    lower(errorEnvelope(data)?.cisError?.faultString),
    lower(errorEnvelope(data)?.otherError?.message),
    lower((data as any)?.response?.text),
  ].filter(Boolean);

  for (const message of messages) {
    if (OTHER_ENTITY.test(message)) continue;
    if (DOC_ABSENT.test(message)) return true;
  }
  return false;
}

/**
 * 400s that are field validation rather than a transient refusal. Kept
 * broad on purpose: a 400 is the provider telling us the payload is wrong,
 * and there is no 400 that a byte-identical retry fixes.
 */
export function isValidationFailure(input: {
  httpStatus?: number;
  data?: unknown;
}): boolean {
  return input.httpStatus === 400 || input.httpStatus === 422;
}

/** The tax service blamed the caller. Retrying sends the same bad data. */
export function isCisClientFault(data: unknown): boolean {
  const env = lower(errorEnvelope(data)?.cisError?.faultEnv);
  return env === CLIENT_ENV || env === 'client';
}

/** The tax service blamed itself. The same request may succeed later. */
export function isCisServerFault(data: unknown): boolean {
  const env = lower(errorEnvelope(data)?.cisError?.faultEnv);
  return env === SERVER_ENV || env === 'server';
}

export function hasCisError(data: unknown): boolean {
  const cis = errorEnvelope(data)?.cisError;
  if (!cis) return false;
  return Boolean(
    lower(cis.faultString) || lower(cis.faultCode) || lower(cis.faultEnv),
  );
}

export function hasOtherError(data: unknown): boolean {
  const other = errorEnvelope(data)?.otherError;
  if (!other) return false;
  return Boolean(lower(other.message) || lower(other.code));
}

function faultMessage(data: unknown): string {
  return readFaultText(data) || '';
}

/**
 * Classify one attempt.
 *
 * Order matters. "Another request is processing" is checked before the
 * status code because the provider returns it with a 400, and treating it
 * as a validation error would abandon a document that is about to exist.
 */
export function classifyFiscalAttempt(
  input: ClassifyInput,
): FiscalClassification {
  const { httpStatus = 0, data, error } = input;

  // Transport: no response body to reason about.
  if (error) {
    if (neverReachedProvider(error)) {
      return {
        action: 'retry',
        outcome: 'not-registered',
        retryable: true,
        mustCheckStatus: false,
        message:
          'The request never reached easyPos (no network, connection refused, or host not resolved), so nothing was filed.',
      };
    }
    if (isAbort(error)) {
      return {
        action: 'check-status',
        outcome: 'unknown',
        retryable: true,
        mustCheckStatus: true,
        message:
          'The request timed out. easyPos may still have filed the document, so its status must be checked before anything is sent again.',
      };
    }
    return {
      action: 'check-status',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message: `Transport failure with an unknown outcome: ${String(
        (error as any)?.message || error,
      )}`,
    };
  }

  if (isAnotherRequestProcessing(data)) {
    return {
      action: 'wait-and-poll',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message:
        'easyPos is already processing a request for this docId. Waiting and polling its status rather than sending again.',
    };
  }

  if (httpStatus === 401) {
    return {
      action: 'renew-token',
      outcome: 'not-registered',
      retryable: true,
      mustCheckStatus: false,
      message:
        'easyPos rejected the access token. Renew it for this environment and retry with the same docId.',
    };
  }

  /**
   * 403 is not 401. The token was accepted and identified; this integration
   * app simply may not call this route. Renewing it produces the same
   * token's worth of permissions and fails identically — and because the
   * recovery sequence allows exactly one renewal per document, treating a
   * 403 as renewable spent that budget on a request that could never
   * succeed, then reported the far vaguer "renewing the token failed".
   */
  if (httpStatus === 403) {
    return {
      action: 'fix-request',
      outcome: 'not-registered',
      retryable: false,
      mustCheckStatus: false,
      message:
        'The token was accepted but this integration app is not permitted to call this endpoint. Check the integration-app header and the permissions on the account, rather than renewing the token.',
    };
  }

  // A CIS fault can arrive on a 200 as well as a 4xx, so read the envelope
  // before falling back to the status code.
  if (isCisClientFault(data)) {
    return {
      action: 'fix-request',
      outcome: 'not-registered',
      retryable: false,
      mustCheckStatus: false,
      message: `The tax service rejected the data (env:CLIENT): ${
        faultMessage(data) || 'no detail supplied'
      }. This needs a corrected request, not a retry.`,
    };
  }

  if (isCisServerFault(data)) {
    return {
      action: 'check-status',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message: `The tax service failed on its own side (env:SERVER): ${
        faultMessage(data) || 'no detail supplied'
      }.`,
    };
  }

  if (isValidationFailure({ httpStatus, data })) {
    return {
      action: 'fix-request',
      outcome: 'not-registered',
      retryable: false,
      mustCheckStatus: false,
      message: `easyPos refused the payload (HTTP ${httpStatus}): ${
        faultMessage(data) || 'no detail supplied'
      }. A byte-identical retry will be refused the same way.`,
    };
  }

  if (httpStatus === 404) {
    return {
      action: 'fix-request',
      outcome: 'not-registered',
      retryable: false,
      mustCheckStatus: false,
      message:
        'Endpoint not found. Check the base URL includes /fiscalisation-service/v1 with no trailing slash.',
    };
  }

  if (httpStatus === 429) {
    return {
      action: 'retry',
      outcome: 'not-registered',
      retryable: true,
      mustCheckStatus: false,
      message: 'easyPos rate-limited the request. Backing off before retrying.',
    };
  }

  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return {
      action: 'check-status',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message: `easyPos returned HTTP ${httpStatus}. The upstream may have filed the document before failing to answer, so its status must be checked before anything is sent again.`,
    };
  }

  if (httpStatus >= 500) {
    return {
      action: 'check-status',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message: `easyPos returned HTTP ${httpStatus}: ${
        faultMessage(data) || 'no detail supplied'
      }.`,
    };
  }

  if (hasOtherError(data)) {
    return {
      action: 'check-status',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message: `easyPos reported otherError: ${faultMessage(data) || 'no detail supplied'}.`,
    };
  }

  if (hasCisError(data)) {
    // A CIS fault with no `faultEnv` to go on. Assume the worst about
    // whether it filed, but keep it retryable through the status path.
    return {
      action: 'check-status',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message: `The tax service raised a fault with no environment given: ${
        faultMessage(data) || 'no detail supplied'
      }.`,
    };
  }

  if (input.incomplete) {
    // HTTP 200 with a body that does not satisfy the completion contract:
    // no fault to read, no identifiers to trust.
    return {
      action: 'check-status',
      outcome: 'unknown',
      retryable: true,
      mustCheckStatus: true,
      message:
        input.incompleteReason ||
        'easyPos answered without the identifiers that mark the document complete.',
    };
  }

  if (httpStatus >= 400) {
    return {
      action: 'fix-request',
      outcome: 'not-registered',
      retryable: false,
      mustCheckStatus: false,
      message: `easyPos returned HTTP ${httpStatus}: ${
        faultMessage(data) || 'no detail supplied'
      }.`,
    };
  }

  return {
    action: 'check-status',
    outcome: 'unknown',
    retryable: true,
    mustCheckStatus: true,
    message: faultMessage(data) || 'Unclassified fiscal failure.',
  };
}
