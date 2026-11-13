/**
 * Masking secrets in text that leaves the till's control: the log file
 * (`fileLog.ts`) and crash reports (`crashReportScrub.ts`). PINs, tokens,
 * the pairing code, licence and recovery keys.
 */
const SECRET_KEYS =
  'pin|pinHash|newPin|managerPin|authToken|token|sessionToken|apiToken|accessToken|refreshToken|pairingCode|apiSecret|secret|recoveryKey|password|licenseKey|approvalToken|managerApprovalToken|approvedByAdminToken';

const KEY_VALUE = new RegExp(
  `((?:["']?)\\b(?:${SECRET_KEYS})\\b(?:["']?)\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&}\\]]+)`,
  'gi',
);
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const LICENSE_KEY = /\bPOS1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Mask secrets in one line of log text. */
export function redactLogText(text: string): string {
  return String(text)
    .replace(JWT, '[redacted-token]')
    .replace(BEARER, '$1 [redacted]')
    .replace(LICENSE_KEY, '[redacted-license]')
    .replace(KEY_VALUE, '$1[redacted]');
}
