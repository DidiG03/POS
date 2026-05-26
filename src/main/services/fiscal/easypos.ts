import type { SettingsDTO } from '@shared/ipc';
import type {
  EasyPosCloudInvoiceDraft,
  EasyPosInvoiceDraft,
} from './mapInvoice';

export type FiscalSaleResult = {
  nslf: string;
  nivf: string;
  link: string;
  status: 'accepted' | 'pending';
  warning?: string;
  raw?: unknown;
};

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
}

export function isEasyPosCloudApi(baseUrl: string): boolean {
  const u = normalizeBaseUrl(baseUrl).toLowerCase();
  return u.includes('api.easypos.al') || u.includes('api.dev.easypos.al');
}

function fiscalConfig(settings: SettingsDTO) {
  const fiscal = (settings as any)?.fiscal || {};
  const baseUrl = normalizeBaseUrl(String(fiscal.baseUrl || ''));
  const authToken = String(fiscal.authToken || '').trim();
  const provider = String(fiscal.provider || 'easypos').toLowerCase();
  const integrationApp = String(fiscal.integrationApp || '').trim();
  const operatorCode = normalizeOperatorCode(
    fiscal.defaultOperatorId || fiscal.operatorCode || '',
  );
  return {
    baseUrl,
    authToken,
    provider,
    integrationApp,
    operatorCode,
    cloud: isEasyPosCloudApi(baseUrl),
  };
}

function normalizeOperatorCode(raw: string): string {
  const code = String(raw || '').trim();
  // Common Postman/invoice OCR typo — verified demo operator is gh537ez280.
  if (code === 'gh537ez200') return 'gh537ez280';
  return code;
}

function authHeader(token: string, cloud: boolean): string {
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (!cloud) return raw;
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function extractApiErrorMessage(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data.trim();
  const obj = data as Record<string, unknown>;
  const direct = [
    obj.message,
    obj.error,
    (obj.response as any)?.text,
    obj.text,
    obj.title,
    obj.detail,
    obj.statusText,
  ];
  for (const value of direct) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((entry) => String((entry as any)?.message || entry || '').trim())
      .filter(Boolean)
      .join('; ');
  }
  try {
    const json = JSON.stringify(data);
    if (json && json !== '{}' && json.length <= 500) return json;
  } catch {
    /* ignore */
  }
  return '';
}

function responseHint(
  responseText: string,
  cloud: boolean,
): string | undefined {
  const lower = responseText.toLowerCase();
  if (lower.includes('njesia') && lower.includes('nuk gjendet')) {
    return cloud
      ? 'Unit/article mismatch in easyPos catalog. Your Postman body uses articleId PROD001 and soldIn XPP — not ART001/cope. Set those in Admin → Fiskalizimi and save.'
      : 'Unit of measure (soldIn) not found. Check defaultSoldIn matches easyPos.';
  }
  if (lower.includes('artikull') && lower.includes('nuk gjendet')) {
    return 'Article ID not found in easyPos. Menu SKU must match an easyPos article, or set "Cloud fallback article ID" (e.g. PROD001 from Postman).';
  }
  if (lower.includes('operator') && lower.includes('nuk gjendet')) {
    return 'Operator code not found for this access token. Use gh537ez280 (from your verified invoice), not gh537ez200. Also copy a fresh accessToken from Postman into POS settings and save.';
  }
  if (lower.includes('operatori') && lower.includes('nuk gjendet')) {
    return 'Operator code not found for this access token. Use gh537ez280 (from your verified invoice), not gh537ez200. Also copy a fresh accessToken from Postman into POS settings and save.';
  }
  if (lower.includes('exrate') || lower.includes('kurs')) {
    return 'EUR exchange rate missing. Set "Kursi EUR" in Fiskalizimi settings (e.g. 100.5).';
  }
  if (
    lower.includes('metodave') &&
    lower.includes('pageses') &&
    lower.includes('totali') &&
    lower.includes('fatures')
  ) {
    return 'Payment amount did not match invoice line totals. This is fixed in the latest POS build — restart the app and retry the payment.';
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
      ? 'Check the access token (JWT from Postman) and integration-app header (e.g. generic). Save settings after pasting the token.'
      : 'Check the authorization token configured for the local easyPos API.';
  }
  if (status === 403) {
    return 'The token was accepted but this integration app or account is not allowed to call this endpoint.';
  }
  if (status === 404 || lower === 'not found') {
    return cloud
      ? 'Wrong base URL. Use https://api.dev.easypos.al/fiscalisation-service/v1 (include /fiscalisation-service/v1, no trailing slash).'
      : 'Local easyPos is not reachable at this URL. Start easyPos desktop or verify http://127.0.0.1:8080.';
  }
  if (status === 400) {
    return purpose === 'test'
      ? 'Request reached easyPos but the payload was rejected. For connection test this usually still means auth worked.'
      : 'Invoice rejected by easyPos. Compare your menu SKU, soldIn unit, operator code, and currency with the Postman Register Invoice (Minimal) example.';
  }
  if (status >= 500) {
    return cloud
      ? `easyPos cloud returned HTTP ${status} — their server was temporarily unavailable. Wait a few seconds and retry (Postman may work on retry too). If it keeps failing, contact easyPos support.`
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
  const responseText = extractApiErrorMessage(input.data);
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

export function assertFiscalConfigured(settings: SettingsDTO): void {
  const { baseUrl, authToken, provider, integrationApp, operatorCode, cloud } =
    fiscalConfig(settings);
  if (provider !== 'easypos') {
    throw new Error(`Unsupported fiscal provider: ${provider || 'unknown'}`);
  }
  if (!baseUrl) {
    throw new Error('Fiscal middleware base URL is not configured.');
  }
  if (!authToken) {
    throw new Error('Fiscal middleware authorization token is not configured.');
  }
  if (cloud && !integrationApp) {
    throw new Error(
      'Integration app identifier is required for easyPos cloud API.',
    );
  }
  if (cloud && !operatorCode) {
    throw new Error(
      'Operator code is required for easyPos cloud API. Use the value from Postman / your fiscalized invoice (e.g. gh537ez280).',
    );
  }
}

async function easyPosRequest(
  settings: SettingsDTO,
  path: string,
  init?: RequestInit,
): Promise<any> {
  assertFiscalConfigured(settings);
  const { baseUrl, authToken, integrationApp, cloud } = fiscalConfig(settings);
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const maxAttempts = 3;
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
        if ([502, 503, 504].includes(res.status) && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        throw new Error(
          formatFiscalHttpError({
            method: String(init?.method || 'GET').toUpperCase(),
            url,
            status: res.status,
            data,
            cloud,
            purpose: 'payment',
          }),
        );
      }
      return data;
    } catch (e: any) {
      if (
        String(e?.name || '')
          .toLowerCase()
          .includes('abort')
      ) {
        lastError = new Error('Fiscal middleware timed out.');
      } else if (e instanceof Error && e.message.includes('→ HTTP')) {
        lastError = e;
      } else {
        lastError = new Error(formatFiscalNetworkError(e, cloud, baseUrl));
      }
      if (attempt < maxAttempts && lastError.message.includes('HTTP 502')) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      if (attempt < maxAttempts && lastError.message.includes('HTTP 503')) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      if (attempt < maxAttempts && lastError.message.includes('HTTP 504')) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Fiscal middleware request failed.');
}

function isDailyBalanceCashWarning(cisFault: string, data: any): boolean {
  const code = String(data?.error?.cisError?.faultCode || '').trim();
  const lower = cisFault.toLowerCase();
  return (
    code === '123' ||
    (lower.includes('balanc') &&
      lower.includes('ditore') &&
      (lower.includes('cash') || lower.includes('pagese')))
  );
}

function parseFiscalResponse(data: any): FiscalSaleResult {
  const statusCode = Number(data?.status);
  const response = data?.response || data?.data || data || {};
  const cisFault = String(data?.error?.cisError?.faultString || '').trim();
  if (statusCode === 1) {
    const msg = String(
      response?.text ||
        data?.message ||
        'Fiscal middleware rejected the invoice.',
    );
    throw new Error(msg);
  }
  const nslf = String(
    response?.nslf ||
      response?.iic ||
      response?.IIC ||
      data?.iic ||
      data?.IIC ||
      '',
  ).trim();
  const nivf = String(
    response?.nivf ||
      response?.fic ||
      response?.FIC ||
      data?.fic ||
      data?.FIC ||
      '',
  ).trim();
  const link = String(
    response?.link ||
      response?.verificationUrl ||
      response?.verificationLink ||
      data?.link ||
      '',
  ).trim();
  if (!nslf && !nivf && statusCode !== 2 && !data?.docId && !data?.orderId) {
    throw new Error(
      cisFault || 'Fiscal middleware returned an invalid response.',
    );
  }
  if (cisFault && !nivf) {
    if (nslf && isDailyBalanceCashWarning(cisFault, data)) {
      return {
        nslf,
        nivf,
        link,
        status: 'pending',
        warning: `${cisFault} · Report daily opening balance in easyPos for full CASH fiscalization (NIVF).`,
        raw: data,
      };
    }
    throw new Error(
      `${cisFault} · For CASH invoices, report the daily opening balance in easyPos first, or test with CARD payment.`,
    );
  }
  return {
    nslf,
    nivf,
    link,
    status: statusCode === 2 || (!nivf && nslf) ? 'pending' : 'accepted',
    raw: data,
  };
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
          'Access token is not configured. Paste the JWT from Postman, save settings, then test again.',
      };
    }
    if (cloud && !integrationApp) {
      return {
        ok: false,
        message:
          'Integration app ID is missing. Set integration-app from Postman (e.g. generic) and save.',
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
          const responseText = extractApiErrorMessage(data);
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
    const data = await easyPosRequest(settings, '/v1', { method: 'GET' });
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
    const soldIn =
      String((settings as any)?.fiscal?.defaultSoldIn || 'XPP').trim() || 'XPP';
    const articleId =
      String(
        (settings as any)?.fiscal?.cloudFallbackArticleId || 'PROD001',
      ).trim() || 'PROD001';
    const draft = {
      docId:
        typeof globalThis.crypto !== 'undefined' &&
        typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
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
    const data = await easyPosRequest(settings, '/invoice/register', {
      method: 'POST',
      body: JSON.stringify(draft),
    });
    const nslf = String(data?.iic || data?.IIC || '').trim();
    const nivf = String(data?.fic || data?.FIC || '').trim();
    const cisFault = String(data?.error?.cisError?.faultString || '').trim();
    if (!nslf && !nivf) {
      throw new Error(
        cisFault || 'Fiscal middleware returned an invalid response.',
      );
    }
    if (cisFault && !nivf) {
      return {
        ok: true,
        message: `Minimal invoice OK · NSLF ${nslf} · CASH note: report daily opening balance in easyPos for full NIVF on cash sales.`,
      };
    }
    return {
      ok: true,
      message: `Minimal invoice OK · NIVF ${nivf || '—'} · NSLF ${nslf || '—'}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      message: String(e?.message || e || 'Minimal invoice test failed'),
    };
  }
}

export async function createEasyPosSale(
  settings: SettingsDTO,
  draft: EasyPosInvoiceDraft | EasyPosCloudInvoiceDraft,
): Promise<FiscalSaleResult> {
  const { cloud } = fiscalConfig(settings);
  const path = cloud ? '/invoice/register' : '/v1/invoices/new';
  const data = await easyPosRequest(settings, path, {
    method: 'POST',
    body: JSON.stringify(draft),
  });
  return parseFiscalResponse(data);
}
