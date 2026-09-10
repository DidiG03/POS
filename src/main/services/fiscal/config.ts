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

export function isEasyPosCloudApi(baseUrl: string): boolean {
  const u = normalizeBaseUrl(baseUrl).toLowerCase();
  return u.includes('api.easypos.al') || u.includes('api.dev.easypos.al');
}

/**
 * Which easyPos environment a base URL addresses.
 *
 * Tokens are environment-scoped, so a 401 has to be renewed against the
 * right one — renewing a dev token because a prod call failed leaves the
 * prod call failing forever.
 */
export function fiscalEnvironmentOf(baseUrl: string): FiscalEnvironment {
  const u = normalizeBaseUrl(baseUrl).toLowerCase();
  if (u.includes('api.dev.easypos.al')) return 'dev';
  if (u.includes('api.easypos.al')) return 'prod';
  return 'local';
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
