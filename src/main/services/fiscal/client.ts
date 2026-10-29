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
 * being written as we ask. The lock covers every route so a cancel or a
 * replay cannot slip between them either.
 */

import type { SettingsDTO } from '@shared/ipc';
import { easyPosFetch } from './transport';
import {
  assertFiscalConfigured,
  authHeader,
  fiscalConfig,
  type FiscalEnvironment,
} from './config';
import type {
  BalanceRequest,
  CancelInvoiceRequest,
  InvoiceStatusRequest,
  RegisterInvoiceRequest,
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

/** Test seam. Never call from application code. */
export function __resetDocIdLocks(): void {
  inFlightByDocId.clear();
}

/* ------------------------------------------------------------------ *
 * One document at a time per device
 * ------------------------------------------------------------------ */

/**
 * easyPos files one document at a time per device and refuses the next
 * while one is in flight ("Një kërkesë tjetër po përpunohet!"). Two waiters
 * paying at once therefore had one payment refused. Routes that create a
 * document queue here, per base URL and token (one device); status, PDF
 * and lookups do not collide and are not held back.
 */
const DOCUMENT_ROUTES = new Set<string>([
  '/invoice/register',
  '/invoice/cancel',
  '/balance/initiate',
  '/balance/deposit',
  '/balance/withdraw',
]);
const deviceQueues = new Map<string, Promise<unknown>>();

function onePerDevice<T>(device: string, fn: () => Promise<T>): Promise<T> {
  const previous = deviceQueues.get(device) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  deviceQueues.set(device, settled);
  void settled.then(() => {
    if (deviceQueues.get(device) === settled) deviceQueues.delete(device);
  });
  return run;
}

/** Test seam. Never call from application code. */
export function __resetDeviceQueues(): void {
  deviceQueues.clear();
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
  const path = route.startsWith('/') ? route : `/${route}`;
  if (DOCUMENT_ROUTES.has(path)) {
    const config = fiscalConfig(settings);
    const device = `${config.baseUrl}|${options?.authToken || config.authToken}`;
    return onePerDevice(device, () =>
      postFiscalNow(settings, route, body, options),
    );
  }
  return postFiscalNow(settings, route, body, options);
}

async function postFiscalNow(
  settings: SettingsDTO,
  route: string,
  body: unknown,
  options?: PostOptions,
): Promise<FiscalHttpResult> {
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
    const res = await easyPosFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
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
