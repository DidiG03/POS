/**
 * Resolved fiscal configuration and the environment it points at.
 *
 * Split out of `easypos.ts` so the request layer, the validators and the
 * recovery sequence can all read it without importing each other.
 */

import type { SettingsDTO } from '@shared/ipc';
import { OPERATOR_CODE_PATTERN } from './apiTypes';

export type FiscalEnvironment = 'dev' | 'prod' | 'local';

export interface ResolvedFiscalConfig {
  baseUrl: string;
  authToken: string;
  provider: string;
  integrationApp: string;
  operatorCode: string;
  /** True for the easyPos Cloud API (as opposed to the local middleware). */
  cloud: boolean;
  environment: FiscalEnvironment;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/g, '');
}

/**
 * The easyPos Cloud hosts, and the environment each one is. Matched
 * exactly against the URL's host: searching the whole string sent the
 * token and the cloud headers to any URL that merely contained one of
 * these names (`https://api.dev.easypos.al.example.com/`,
 * `https://evil.test/?api.easypos.al`).
 */
export const EASYPOS_CLOUD_HOSTS: Readonly<Record<string, 'dev' | 'prod'>> = {
  'api.dev.easypos.al': 'dev',
  'api.easypos.al': 'prod',
};

/** The cloud environment of a base URL, or null for anything else. */
function cloudEnvironmentOf(baseUrl: string): 'dev' | 'prod' | null {
  let url: URL;
  try {
    url = new URL(normalizeBaseUrl(baseUrl));
  } catch {
    return null;
  }
  // The token travels to easyPos over TLS only.
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return Object.prototype.hasOwnProperty.call(EASYPOS_CLOUD_HOSTS, host)
    ? EASYPOS_CLOUD_HOSTS[host]
    : null;
}

/** Mentions easyPos Cloud anywhere (for refusing lookalikes). */
export function looksLikeEasyPosCloud(baseUrl: string): boolean {
  return /easypos\.al/i.test(String(baseUrl || ''));
}

/**
 * Why a fiscal base URL cannot be used, or null. Checked when the settings
 * are saved, not only when the first invoice is sent: a lookalike of the
 * easyPos hosts (`https://api.easypos.al.example.com`, plain http, another
 * port) used to be stored and only refused at the next sale.
 */
export function fiscalBaseUrlProblem(baseUrl: string): string | null {
  const raw = normalizeBaseUrl(baseUrl);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return `The fiscal URL "${raw}" is not a web address.`;
    }
  } catch {
    return `The fiscal URL "${raw}" is not a valid address.`;
  }
  if (looksLikeEasyPosCloud(raw) && !isEasyPosCloudApi(raw)) {
    // Not one of the easyPos hosts, but made to look like one: the token
    // must not go there, as cloud or as local middleware.
    return `The fiscal URL "${raw}" is not an easyPos Cloud address (${Object.keys(
      EASYPOS_CLOUD_HOSTS,
    )
      .map((h) => `https://${h}`)
      .join(' or ')}).`;
  }
  return null;
}

export function isEasyPosCloudApi(baseUrl: string): boolean {
  return cloudEnvironmentOf(baseUrl) !== null;
}

/**
 * Which easyPos environment a base URL addresses.
 *
 * Tokens are environment-scoped, so a 401 has to be renewed against the
 * right one — renewing a dev token because a prod call failed leaves the
 * prod call failing forever.
 */
export function fiscalEnvironmentOf(baseUrl: string): FiscalEnvironment {
  return cloudEnvironmentOf(baseUrl) ?? 'local';
}

/**
 * Trim only.
 *
 * This used to rewrite `gh537ez200` to `gh537ez280`, because the demo
 * account's operator code was routinely mis-transcribed from a printed
 * invoice. That is not a normalisation — both are well-formed operator
 * codes under `OPERATOR_CODE_PATTERN`, so the rule silently files a
 * venue's invoices under an operator they did not choose, and would do so
 * for any real business whose code happens to be that one. A typo has to
 * fail loudly: the operator code goes in the fiscal record, and guessing
 * at it is worse than refusing it.
 *
 * The typo is still caught, in the two places that can say something
 * useful about it — the settings screen refuses to save it, and
 * `responseHint` turns easyPos' "Operatori nuk gjendet" into the exact
 * correction.
 */
export function normalizeOperatorCode(raw: string): string {
  return String(raw || '').trim();
}

export function isValidOperatorCode(raw: string): boolean {
  return OPERATOR_CODE_PATTERN.test(String(raw || '').trim());
}

export function fiscalConfig(settings: SettingsDTO): ResolvedFiscalConfig {
  const fiscal = (settings as any)?.fiscal || {};
  const baseUrl = normalizeBaseUrl(String(fiscal.baseUrl || ''));
  return {
    baseUrl,
    authToken: String(fiscal.authToken || '').trim(),
    provider: String(fiscal.provider || 'easypos').toLowerCase(),
    integrationApp: String(fiscal.integrationApp || '').trim(),
    operatorCode: normalizeOperatorCode(
      fiscal.defaultOperatorId || fiscal.operatorCode || '',
    ),
    cloud: isEasyPosCloudApi(baseUrl),
    environment: fiscalEnvironmentOf(baseUrl),
  };
}

export function authHeader(token: string, cloud: boolean): string {
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (!cloud) return raw;
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
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
  const problem = fiscalBaseUrlProblem(baseUrl);
  if (problem) throw new Error(`${problem} Fix it in Admin → Fiskalizimi.`);
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
      'Operator code is required for easyPos cloud API. Set it in Admin → Fiskalizimi to a code issued by the tax service (two letters, three digits, two letters, three digits).',
    );
  }
  if (cloud && !isValidOperatorCode(operatorCode)) {
    throw new Error(
      `Operator code "${operatorCode}" is not in the format the tax service issues (two letters, three digits, two letters, three digits — e.g. gh537ez280).`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The settings as they are now
 * ------------------------------------------------------------------ */

let settingsSource: (() => Promise<SettingsDTO | null | undefined>) | null =
  null;

/**
 * Where fiskalizimi reads the current settings from. Set once at start-up
 * (the till's settings store). Retries used to keep the settings they were
 * started with, so after the easyPos URL was changed the queue went on
 * sending to the old one.
 */
export function setFiscalSettingsSource(
  source: (() => Promise<SettingsDTO | null | undefined>) | null,
): void {
  settingsSource = source;
}

/** The current settings, or `fallback` when none can be read. */
export async function latestFiscalSettings(
  fallback: SettingsDTO,
): Promise<SettingsDTO> {
  if (!settingsSource) return fallback;
  const fresh = await settingsSource().catch(() => null);
  return fresh || fallback;
}
