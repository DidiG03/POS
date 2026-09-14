import type { SettingsDTO } from '@shared/ipc';
import type {
  EasyPosCloudInvoiceDraft,
  EasyPosInvoiceDraft,
} from './mapInvoice';
// Only what this module actually calls. The rest of `./config` is
// re-exported below for callers that still import it from here.
import { assertFiscalConfigured, authHeader, fiscalConfig } from './config';
import {
  assessCompletion,
  readFaultText,
  targetForInvoice,
} from './completion';
// One definition of "the request never left this machine", shared with the
// recovery sequence. The copy that used to live here read only one level of
// `cause`, and undici puts `ECONNREFUSED` two levels down behind a bare
// `fetch failed` — so a connection that provably never reached easyPos was
// classified as an unknown outcome and sent a retryable sale to review.
import { classifyFiscalAttempt, neverReachedProvider } from './classify';
import { registerInvoiceWithRecovery, type RecoveryOptions } from './recover';
import { newDocId } from './docId';
import type { RegisterInvoiceRequest, CancelInvoiceRequest } from './apiTypes';

export {
  assertFiscalConfigured,
  isEasyPosCloudApi,
  normalizeOperatorCode,
} from './config';

export type FiscalSaleResult = {
  nslf: string;
  nivf: string;
  /** Electronic invoice identifier. Present only for e-invoices. */
  eic?: string;
  link: string;
  qrCode?: string;
  /**
   * Only ever `'accepted'` now. Kept in the shape because receipts, the
   * claim store and the LAN API all read it.
   *
   * There is no longer a `'pending'` success: an invoice without a NIVF is
   * not registered, and reporting it as a partial success is what printed
   * receipts claiming fiskalizimi for documents the tax service had never
   * accepted.
   */
  status: 'accepted';
  warning?: string;
  raw?: unknown;
};

/**
 * Whether a failed attempt could have left a real invoice on the provider.
 *
 * `unknown` is not a nicety: retrying one of those can register a second
 * tax document for the same sale, which needs a corrective invoice to
 * undo. Only `not-registered` may be retried automatically.
 *
 * Re-exported from `classify.ts` rather than declared again. The two
 * declarations were identical, so they stayed compatible by luck: adding a
 * third state to the classifier would have left this copy silently
 * narrower and the mismatch would surface as a type error somewhere
 * unrelated.
 */
export type { FiscalOutcome } from './classify';
import type { FiscalOutcome } from './classify';

export interface FiscalError extends Error {
  fiscalOutcome: FiscalOutcome;
  /**
   * False when the same request will keep failing until a human changes
   * something — a bad article id, an unknown operator code, a missing
   * exchange rate. Retrying those forever just hammers easyPos and leaves
   * the payment stuck with nobody told why.
   */
  fiscalRetryable: boolean;
}

function fiscalError(
  message: string,
  outcome: FiscalOutcome,
  retryable = true,
): FiscalError {
  const err = new Error(message) as FiscalError;
  err.fiscalOutcome = outcome;
  err.fiscalRetryable = retryable;
  return err;
}

/** Anything we did not explicitly classify is assumed to have registered. */
export function fiscalOutcomeOf(error: unknown): FiscalOutcome {
  const tagged = (error as Partial<FiscalError> | null)?.fiscalOutcome;
  return tagged === 'not-registered' ? 'not-registered' : 'unknown';
}

/** False only when we know a retry cannot succeed without a change. */
export function isFiscalRetryable(error: unknown): boolean {
  return (error as Partial<FiscalError> | null)?.fiscalRetryable !== false;
}

function responseHint(
  responseText: string,
  cloud: boolean,
): string | undefined {
  const lower = responseText.toLowerCase();
  if (lower.includes('njesia') && lower.includes('nuk gjendet')) {
    return cloud
      ? 'Unit of measure (soldIn) is not in the easyPos catalog. Set it in Admin → Fiskalizimi to a unit that exists there.'
      : 'Unit of measure (soldIn) not found. Check defaultSoldIn matches easyPos.';
  }
  if (lower.includes('artikull') && lower.includes('nuk gjendet')) {
    return 'Article ID not found in easyPos. Menu SKUs must match articles in the easyPos catalog. The fallback article ID is only used for lines with no SKU.';
  }
  if (
    (lower.includes('operator') || lower.includes('operatori')) &&
    lower.includes('nuk gjendet')
  ) {
    return 'Operator code not found for this access token. Check the operator code in Admin → Fiskalizimi, and that it is one this token may use.';
  }
  if (lower.includes('exrate') || lower.includes('kurs')) {
    return 'Exchange rate against ALL is missing. Set it in Admin → Fiskalizimi.';
  }
  if (
    lower.includes('metodave') &&
    lower.includes('pageses') &&
    lower.includes('totali') &&
    lower.includes('fatures')
  ) {
    return 'Payment amounts do not match the invoice total. The API requires them to be equal.';
  }
  return undefined;
}

function statusHint(
  status: number,
  cloud: boolean,
  responseText: string,
  purpose: 'payment' | 'test' = 'payment',
): string | undefined {
  const specific = responseHint(responseText, cloud);
  if (specific) return specific;

  const lower = responseText.toLowerCase();
  if (
    status === 401 ||
    lower.includes('unauthorized') ||
    lower.includes('not authorized')
  ) {
    return cloud
      ? 'Check the access token and the integration-app header in Admin → Fiskalizimi, then save and try again.'
      : 'Check the authorization token configured for the local easyPos API.';
  }
  if (status === 403) {
    return 'The token was accepted but this integration app or account is not allowed to call this endpoint.';
  }
  if (status === 404 || lower === 'not found') {
    return cloud
      ? 'Wrong base URL. Use https://api.dev.easypos.al/fiscalisation-service/v1 or the production equivalent (include /fiscalisation-service/v1, no trailing slash).'
      : 'Local easyPos is not reachable at this URL. Start easyPos desktop or verify http://127.0.0.1:8080.';
  }
  if (status === 400) {
    return purpose === 'test'
      ? 'Request reached easyPos but the payload was rejected. For a connection test this usually still means auth worked.'
      : 'Invoice rejected by easyPos. Check that the menu SKU, soldIn unit, operator code, and currency match the easyPos catalog.';
  }
  if (status >= 500) {
    return cloud
      ? `easyPos cloud returned HTTP ${status} — their server was temporarily unavailable. Wait a few seconds and retry. If it keeps failing, contact easyPos support.`
      : 'easyPos server error — try again later or contact easyPos support.';
  }
  if (status === 0) {
    return 'No HTTP response — check network, firewall, and that the URL is correct.';
  }
  return undefined;
}

function formatFiscalHttpError(input: {
  method: string;
  url: string;
  status: number;
  data: unknown;
  cloud: boolean;
  purpose?: 'payment' | 'test';
}): string {
  const responseText = readFaultText(input.data) || '';
  const parts = [`${input.method} ${input.url} → HTTP ${input.status}`];
  if (responseText) {
    parts.push(`Response: ${responseText}`);
  }
  const hint = statusHint(
    input.status,
    input.cloud,
    responseText,
    input.purpose || 'payment',
  );
  if (hint) parts.push(hint);
  return parts.join(' · ');
}

function formatFiscalNetworkError(
  error: unknown,
  cloud: boolean,
  baseUrl: string,
): string {
  const message = String((error as any)?.message || error || '').trim();
  const cause = String(
    (error as any)?.cause?.message || (error as any)?.cause || '',
  ).trim();
  const combined = `${message} ${cause}`.toLowerCase();
  if (combined.includes('abort')) {
    return `Request timed out after 20s · ${cloud ? 'Cloud' : 'Local'} URL: ${baseUrl}`;
  }
  if (
    combined.includes('econnrefused') ||
    combined.includes('connection refused') ||
    combined.includes('enetunreach') ||
    combined.includes('enetdown') ||
    combined.includes('ehostunreach') ||
    combined.includes('ehostdown') ||
    combined.includes('network is unreachable') ||
    combined.includes('no route to host') ||
    combined.includes('internet disconnected') ||
    combined.includes('fetch failed')
  ) {
    return cloud
      ? `Could not reach easyPos cloud at ${baseUrl} · Check internet connection and base URL.`
      : `Could not reach local easyPos at ${baseUrl} · Start easyPos desktop on this machine.`;
  }
  if (combined.includes('enotfound') || combined.includes('getaddrinfo')) {
    return `Could not resolve host for ${baseUrl} · Check the base URL spelling.`;
  }
  if (message) return message;
  return 'Connection failed.';
}

function isConnectionTestValidationError(
  status: number,
  responseText: string,
): boolean {
  if (status !== 400) return false;
  const lower = responseText.toLowerCase();
  return [
    'docid',
    'doc id',
    'articles',
    'payment',
    'operator',
    'mungon',
    'required',
    'validation',
    'invalid',
  ].some((token) => lower.includes(token));
}

async function easyPosRequest(
  settings: SettingsDTO,
  path: string,
  init?: RequestInit,
  options?: { retryOnGatewayError?: boolean },
): Promise<any> {
  assertFiscalConfigured(settings);
  const { baseUrl, authToken, integrationApp, cloud } = fiscalConfig(settings);
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  // Registering an invoice is not idempotent from our side: a 502/503/504
  // means the upstream may already have filed it, so re-POSTing is the
  // very thing that creates a duplicate tax document. Read-only calls and
  // the connection test are free to retry.
  const retryGateway = options?.retryOnGatewayError !== false;
  const maxAttempts = retryGateway ? 3 : 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authHeader(authToken, cloud),
        ...(init?.headers as Record<string, string> | undefined),
      };
      if (cloud && integrationApp) {
        headers['integration-app'] = integrationApp;
      }
      const res = await fetch(url, {
        ...init,
        headers,
        signal: ac.signal,
      } as any);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (
          retryGateway &&
          [502, 503, 504].includes(res.status) &&
          attempt < maxAttempts
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        throw fiscalError(
          formatFiscalHttpError({
            method: String(init?.method || 'GET').toUpperCase(),
            url,
            status: res.status,
            data,
            cloud,
            purpose: 'payment',
          }),
          // A 4xx is the provider refusing the payload, so nothing was
          // filed. A 5xx may have filed it and then failed to tell us.
          res.status >= 500 ? 'unknown' : 'not-registered',
          // A refused payload (bad article, unknown operator, bad token)
          // will be refused identically every time until it is corrected.
          res.status >= 500,
        );
      }
      return data;
    } catch (e: any) {
      if (
        String(e?.name || '')
          .toLowerCase()
          .includes('abort')
      ) {
        // We stopped listening; the provider may still have filed it.
        lastError = fiscalError('Fiscal middleware timed out.', 'unknown');
      } else if (e instanceof Error && e.message.includes('→ HTTP')) {
        lastError = e;
      } else {
        lastError = fiscalError(
          formatFiscalNetworkError(e, cloud, baseUrl),
          neverReachedProvider(e) ? 'not-registered' : 'unknown',
        );
      }
      // No gateway retry here. A 502/503/504 has already either been
      // retried by the `!res.ok` branch above or exhausted the budget and
      // been thrown — so the three blocks that used to sit here, each
      // re-deciding that by string-matching "HTTP 502" against the rendered
      // error message, could never fire. Retry logic that reads its own
      // error text is a second implementation of a decision the code above
      // has already made properly, and it drifts the moment the message
      // wording changes.
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw (
    lastError || fiscalError('Fiscal middleware request failed.', 'unknown')
  );
}

/**
 * The tax service refusing a cash invoice because the day's opening
 * balance was never declared.
 *
 * Detected so the message can point at the actual remedy — which is now
 * `POST /balance/initiate` via `initiateDailyBalance`, not a note asking
 * staff to go and do it by hand in easyPos.
 */
function isDailyBalanceCashFault(faultText: string, data: any): boolean {
  const code = String(data?.error?.cisError?.faultCode || '').trim();
  const lower = faultText.toLowerCase();
  return (
    code === '123' ||
    (lower.includes('balanc') &&
      lower.includes('ditore') &&
      (lower.includes('cash') || lower.includes('pagese')))
  );
}

/**
 * Turn a response into a result, or throw a classified error.
 *
 * The completion contract decides, not the HTTP status and not the shape
 * of the body. `assessCompletion` requires `fic` (and `eic` too for an
 * electronic invoice), so the three ways the old parser could report a
 * non-registration as a success are all closed:
 *
 *   - an `iic`/NSLF with no NIVF used to come back as `status: 'pending'`;
 *   - the daily-balance CASH fault used to come back as a `pending`
 *     success carrying a warning;
 *   - an echoed `docId` with a `status` field used to be enough.
 */
function resultFromResponse(input: {
  data: unknown;
  httpStatus: number;
  isEinvoice?: boolean;
}): FiscalSaleResult {
  const target = targetForInvoice({ isEinvoice: input.isEinvoice });
  const verdict = assessCompletion(target, input.data);
  if (verdict.complete) {
    return {
      nslf: verdict.identifiers.iic || '',
      nivf: verdict.identifiers.fic || '',
      ...(verdict.identifiers.eic ? { eic: verdict.identifiers.eic } : {}),
      link: verdict.identifiers.link || '',
      ...(verdict.identifiers.qrCode
        ? { qrCode: verdict.identifiers.qrCode }
        : {}),
      status: 'accepted',
      raw: input.data,
    };
  }

  const classification = classifyFiscalAttempt({
    httpStatus: input.httpStatus,
    data: input.data,
    incomplete: true,
    incompleteReason: verdict.reason,
  });

  const fault = readFaultText(input.data) || '';
  let message = classification.message;
  if (fault && isDailyBalanceCashFault(fault, input.data)) {
    message = `${fault} · The opening cash balance for today has not been declared for this device. Declare it (Admin → Fiskalizimi → opening balance) before taking cash payments.`;
  }

  throw fiscalError(message, classification.outcome, classification.retryable);
}

export async function testEasyPosConnection(
  settings: SettingsDTO,
): Promise<{ ok: boolean; message?: string; messageKey?: string }> {
  try {
    const { cloud, baseUrl, authToken, integrationApp } =
      fiscalConfig(settings);
    if (!baseUrl) {
      return { ok: false, message: 'Base URL is not configured.' };
    }
    if (!authToken) {
      return {
        ok: false,
        message:
          'Access token is not configured. Paste the JWT in Admin → Fiskalizimi, save, then test again.',
      };
    }
    if (cloud && !integrationApp) {
      return {
        ok: false,
        message:
          'Integration app ID is missing. Set the integration-app header in Admin → Fiskalizimi and save.',
      };
    }
    if (cloud) {
      // Cloud Public API has no GET /operators. Auth-check by POSTing to the
      // real register route — 401 = bad credentials, 404 = wrong base URL,
      // 400 = reached service with valid auth but invalid test body.
      const url = `${baseUrl}/invoice/register`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: authHeader(authToken, true),
            'integration-app': integrationApp,
          },
          body: JSON.stringify({}),
          signal: ac.signal,
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          return { ok: true, messageKey: 'testOkCloud' };
        }
        if (res.status === 400) {
          const responseText = readFaultText(data) || '';
          if (isConnectionTestValidationError(res.status, responseText)) {
            // Empty test body — API rejects missing invoice fields but auth succeeded.
            return { ok: true, messageKey: 'testOkCloudAuth' };
          }
        }
        if (res.status === 400) {
          throw new Error(
            formatFiscalHttpError({
              method: 'POST',
              url,
              status: res.status,
              data,
              cloud: true,
              purpose: 'test',
            }),
          );
        }
        throw new Error(
          formatFiscalHttpError({
            method: 'POST',
            url,
            status: res.status,
            data,
            cloud: true,
          }),
        );
      } catch (e: any) {
        if (e instanceof Error && e.message.includes('→ HTTP')) {
          throw e;
        }
        throw new Error(formatFiscalNetworkError(e, true, baseUrl));
      } finally {
        clearTimeout(timer);
      }
    }
    // One shot. With the gateway retry left on, an unresponsive local
    // middleware held the settings screen's Test button for three 20s
    // timeouts before answering — a minute of a spinner to report that
    // something is not reachable, which one attempt establishes just as well.
    const data = await easyPosRequest(
      settings,
      '/v1',
      { method: 'GET' },
      { retryOnGatewayError: false },
    );
    const text = String(
      (data as any)?.response?.text || (data as any)?.text || '',
    ).trim();
    return { ok: true, messageKey: 'testOkLocal', message: text || undefined };
  } catch (e: any) {
    return {
      ok: false,
      message: String(e?.message || e || 'Connection failed'),
    };
  }
}

export function getFiscalTokenHint(settings: SettingsDTO): {
  configured: boolean;
  suffix?: string;
  tokenId?: string;
  deviceTail?: string;
} {
  const token = String((settings as any)?.fiscal?.authToken || '').trim();
  if (!token) return { configured: false };
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'),
    );
    return {
      configured: true,
      suffix: token.slice(-12),
      tokenId: String(payload?.tokenId || '').slice(-8) || undefined,
      deviceTail: String(payload?.deviceId || '').slice(-8) || undefined,
    };
  } catch {
    return { configured: true, suffix: token.slice(-12) };
  }
}

export async function testMinimalCloudInvoice(
  settings: SettingsDTO,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const { cloud } = fiscalConfig(settings);
    if (!cloud) {
      return {
        ok: false,
        message: 'Minimal invoice test is for easyPos cloud only.',
      };
    }
    const { defaultSoldIn, cloudFallbackArticleId } =
      (settings as any)?.fiscal || {};
    const soldIn = String(defaultSoldIn || 'XPP').trim() || 'XPP';
    const articleId = String(cloudFallbackArticleId || '').trim();
    if (!articleId) {
      return {
        ok: false,
        message:
          'Set a fallback article ID in Admin → Fiskalizimi first. The test invoice needs an article that exists in the easyPos catalog.',
      };
    }
    const draft = {
      docId: newDocId('invoice'),
      articles: [
        {
          articleId,
          vatCode: 'B',
          name: 'Product Name',
          soldIn,
          price: 100,
          units: 2,
        },
      ],
      payment: [{ type: 'CASH', amount: 200 }],
    };
    // Judged by the same completion contract as a real sale: a test that
    // passes on an NSLF alone reports the integration as working when cash
    // invoices are in fact not being registered at all.
    const result = await createEasyPosSale(settings, draft as any, {
      // A settings screen should answer quickly rather than sit through a
      // full recovery; a real sale gets the full budget.
      maxSendAttempts: 1,
      maxStatusPolls: 1,
    });
    return {
      ok: true,
      message: `Minimal invoice OK · NIVF ${result.nivf} · NSLF ${result.nslf || '—'}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      message: String(e?.message || e || 'Minimal invoice test failed'),
    };
  }
}

/**
 * Register a sale.
 *
 * On the cloud API this now runs the full recovery sequence — register,
 * back off, `POST /invoice/status` with the same docId, and replay only if
 * the provider says it has never seen that docId. Previously a gateway
 * error or a timeout here simply threw as an unknown outcome and the sale
 * went to a human, because nothing ever asked easyPos what had actually
 * happened. That was safe against duplicates and produced a steady trickle
 * of sales stuck in review that had in fact been filed perfectly.
 *
 * The local middleware path is unchanged apart from the completion
 * contract: single shot, no recovery, because it has no status route.
 */
export async function createEasyPosSale(
  settings: SettingsDTO,
  draft: EasyPosInvoiceDraft | EasyPosCloudInvoiceDraft,
  options?: RecoveryOptions,
): Promise<FiscalSaleResult> {
  const { cloud } = fiscalConfig(settings);
  const isEinvoice = (draft as any)?.isEinvoice === true;

  if (!cloud) {
    const data = await easyPosRequest(
      settings,
      '/v1/invoices/new',
      { method: 'POST', body: JSON.stringify(draft) },
      // One shot. The legacy middleware offers no way to ask what happened,
      // so a re-POST is the very thing that files a second document.
      { retryOnGatewayError: false },
    );
    return resultFromResponse({ data, httpStatus: 200, isEinvoice });
  }

  const outcome = await registerInvoiceWithRecovery(
    settings,
    draft as unknown as RegisterInvoiceRequest,
    options,
  );

  if (outcome.kind === 'complete') {
    return {
      nslf: outcome.identifiers.iic || '',
      nivf: outcome.identifiers.fic || '',
      ...(outcome.identifiers.eic ? { eic: outcome.identifiers.eic } : {}),
      link: outcome.identifiers.link || '',
      ...(outcome.identifiers.qrCode
        ? { qrCode: outcome.identifiers.qrCode }
        : {}),
      status: 'accepted',
      raw: outcome.raw,
    };
  }

  if (outcome.kind === 'rejected') {
    // Provably nothing filed, and it will be refused identically until the
    // data or the configuration changes.
    throw fiscalError(outcome.message, 'not-registered', false);
  }
  if (outcome.kind === 'not-registered') {
    throw fiscalError(outcome.message, 'not-registered', true);
  }
  // 'unresolved': the recovery sequence could not establish whether the
  // document exists. Never retried automatically.
  throw fiscalError(outcome.message, 'unknown', false);
}

/**
 * Local easyPos middleware: a cancellation is a new invoice of type CANCEL
 * on `/v1/invoices/new`, not the cloud `/invoice/cancel` route.
 *
 * One shot, no status poll — the middleware has none. A timeout is
 * unknown, same as a local register.
 */
export async function createEasyPosCancellation(
  settings: SettingsDTO,
  request: CancelInvoiceRequest,
): Promise<FiscalSaleResult> {
  const { cloud } = fiscalConfig(settings);
  if (cloud) {
    throw new Error(
      'createEasyPosCancellation is the local-middleware path. Cloud cancellations use POST /invoice/cancel.',
    );
  }
  const body = {
    app: 'OneTap POS',
    invoiceType: 'CANCEL',
    iicRef: request.correctiveInvoice.iicRef,
    docId: request.docId,
    ...(request.operatorCode ? { operatorCode: request.operatorCode } : {}),
  };
  const data = await easyPosRequest(
    settings,
    '/v1/invoices/new',
    { method: 'POST', body: JSON.stringify(body) },
    { retryOnGatewayError: false },
  );
  return resultFromResponse({
    data,
    httpStatus: 200,
    isEinvoice: request.isEinvoice === true,
  });
}
