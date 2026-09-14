/**
 * The transport for every easyPos Cloud Fiscalisation route.
 *
 * Two rules this layer exists to enforce.
 *
 * It does not retry. The old request helper retried 502/503/504 by itself,
 * which meant a re-POST of `/invoice/register` could happen underneath a
 * caller that believed it had sent one request. Recovery needs the status
 * check between attempts, so it belongs to `recover.ts` and nothing else
 * may quietly do its own.
 *
 * It serialises by docId. `/invoice/register` and `/invoice/status` for the
 * same document must never be in flight together — the provider answers
 * "another request is processing", and worse, a status check that races the
 * register it is checking on can report "not found" for an invoice that is
 * being written as we ask. The lock covers every route so a cancel, a PDF
 * or a replay cannot slip between them either.
 */

import type { SettingsDTO } from '@shared/ipc';
import {
  assertFiscalConfigured,
  authHeader,
  fiscalConfig,
  type FiscalEnvironment,
} from './config';
import type {
  BalanceRequest,
  CancelInvoiceRequest,
  GetOperatorsRequest,
  GetTaxpayersRequest,
  InvoicePdfRequest,
  InvoiceStatusRequest,
  OperatorRecord,
  RegisterInvoiceRequest,
  TaxpayerRecord,
} from './apiTypes';

export const FISCAL_ROUTES = {
  register: '/invoice/register',
  cancel: '/invoice/cancel',
  status: '/invoice/status',
  pdf: '/invoice/pdf',
  balanceInitiate: '/balance/initiate',
  balanceDeposit: '/balance/deposit',
  balanceWithdraw: '/balance/withdraw',
  getTaxpayers: '/utilities/get-taxpayers',
  getOperators: '/utilities/get-operators',
} as const;

export type FiscalRoute = (typeof FISCAL_ROUTES)[keyof typeof FISCAL_ROUTES];

/** Per-request timeout. Generous: the tax service is slow under load. */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * One attempt's result. A non-2xx is data, not an exception — the caller
 * classifies it, and a thrown error would lose the body that says why.
 */
export interface FiscalHttpResult {
  ok: boolean;
  httpStatus: number;
  data: unknown;
  route: string;
  environment: FiscalEnvironment;
}

/**
 * Transport failure: no HTTP response exists. Carries the original error so
 * `classifyFiscalAttempt` can read the `cause` chain for the socket code.
 */
export class FiscalTransportError extends Error {
  readonly cause: unknown;
  readonly route: string;
  constructor(message: string, route: string, cause: unknown) {
    super(message);
    this.name = 'FiscalTransportError';
    this.route = route;
    this.cause = cause;
  }
}

/* ------------------------------------------------------------------ *
 * Per-docId serialisation
 * ------------------------------------------------------------------ */

const inFlightByDocId = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `docId`.
 *
 * Queues rather than rejects: a tablet retrying a payment should wait for
 * the first attempt's recovery to conclude and then observe its result,
 * not be told to go away and come back.
 */
export function withDocIdLock<T>(
  docId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = String(docId || '').trim();
  if (!key) return fn();

  const previous = inFlightByDocId.get(key) ?? Promise.resolve();
  // `.then(run, run)` so a rejected predecessor still releases the lock
  // instead of wedging every later attempt on the same document.
  const run = () => fn();
  const next = previous.then(run, run);

  // Park the failure: this handle exists only to sequence the queue, and an
  // unhandled rejection here would crash the main process.
  const guard = next.then(
    () => undefined,
    () => undefined,
  );
  inFlightByDocId.set(key, guard);
  void guard.then(() => {
    if (inFlightByDocId.get(key) === guard) inFlightByDocId.delete(key);
  });
  return next;
}

/** True while any request for this docId is in flight. Diagnostics only. */
export function isDocIdBusy(docId: string): boolean {
  return inFlightByDocId.has(String(docId || '').trim());
}

/** Test seam. Never call from application code. */
export function __resetDocIdLocks(): void {
  inFlightByDocId.clear();
}

/* ------------------------------------------------------------------ *
 * Request primitive
 * ------------------------------------------------------------------ */

export interface PostOptions {
  timeoutMs?: number;
  /** Overrides the token for this call (used after a renewal). */
  authToken?: string;
  signal?: AbortSignal;
}

/**
 * POST one fiscal route exactly once.
 *
 * Sends `Authorization` and `integration-app` on every cloud request, as
 * the API requires on all routes and not just the invoice ones.
 */
export async function postFiscal(
  settings: SettingsDTO,
  route: string,
  body: unknown,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  assertFiscalConfigured(settings);
  const config = fiscalConfig(settings);
  const url = `${config.baseUrl}${route.startsWith('/') ? route : `/${route}`}`;
  const token = String(options?.authToken || config.authToken);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, options?.timeoutMs ?? REQUEST_TIMEOUT_MS),
  );
  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onExternalAbort);

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader(token, config.cloud),
    };
    if (config.cloud && config.integrationApp) {
      headers['integration-app'] = config.integrationApp;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    } as any);
    const data = await res.json().catch(() => null);
    return {
      ok: res.ok,
      httpStatus: res.status,
      data,
      route,
      environment: config.environment,
    };
  } catch (e) {
    throw new FiscalTransportError(
      String((e as any)?.message || e || 'Fiscal request failed.'),
      route,
      e,
    );
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Register an invoice. Single attempt, no lock — `recover.ts` owns both,
 * because the lock has to span the register/status/replay sequence rather
 * than each call inside it.
 */
export function postRegisterInvoice(
  settings: SettingsDTO,
  request: RegisterInvoiceRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.register, request, options);
}

export function postCancelInvoice(
  settings: SettingsDTO,
  request: CancelInvoiceRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  const iicRef = String(request.correctiveInvoice?.iicRef || '').trim();
  const body: CancelInvoiceRequest = {
    docId: String(request.docId || '').trim(),
    correctiveInvoice: { iicRef },
  };
  const operatorCode = String(request.operatorCode || '').trim();
  if (operatorCode) body.operatorCode = operatorCode;
  if (request.isEinvoice === true) {
    body.isEinvoice = true;
    if (request.selectedProcess) body.selectedProcess = request.selectedProcess;
  }
  return postFiscal(settings, FISCAL_ROUTES.cancel, body, options);
}

export function postInvoiceStatus(
  settings: SettingsDTO,
  request: InvoiceStatusRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.status, request, options);
}

export function postInvoicePdf(
  settings: SettingsDTO,
  request: InvoicePdfRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.pdf, request, options);
}

export function postBalanceInitiate(
  settings: SettingsDTO,
  request: BalanceRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.balanceInitiate, request, options);
}

export function postBalanceDeposit(
  settings: SettingsDTO,
  request: BalanceRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.balanceDeposit, request, options);
}

export function postBalanceWithdraw(
  settings: SettingsDTO,
  request: BalanceRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.balanceWithdraw, request, options);
}

export function postGetTaxpayers(
  settings: SettingsDTO,
  request: GetTaxpayersRequest,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.getTaxpayers, request, options);
}

export function postGetOperators(
  settings: SettingsDTO,
  request: GetOperatorsRequest = {},
  options?: PostOptions,
): Promise<FiscalHttpResult> {
  return postFiscal(settings, FISCAL_ROUTES.getOperators, request, options);
}

/* ------------------------------------------------------------------ *
 * List extraction
 * ------------------------------------------------------------------ */

/**
 * Utilities routes have shipped their payload bare, under `response`, and
 * under a named key. Read all three rather than guessing.
 */
function extractList(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const body = (data || {}) as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  const nested = body.response;
  if (Array.isArray(nested)) return nested;
  if (nested && typeof nested === 'object') {
    for (const key of keys) {
      const value = (nested as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as unknown[];
    }
  }
  const dataKey = body.data;
  if (Array.isArray(dataKey)) return dataKey;
  return [];
}

export function readTaxpayers(data: unknown): TaxpayerRecord[] {
  return extractList(data, [
    'taxpayers',
    'items',
    'results',
  ]) as TaxpayerRecord[];
}

export function readOperators(data: unknown): OperatorRecord[] {
  return extractList(data, [
    'operators',
    'items',
    'results',
  ]) as OperatorRecord[];
}
