/**
 * electron-updater GitHub 404s when the release is missing the platform
 * feed file (`latest.yml` on Windows POS, `admin.yml`, `kds.yml`, or
 * `latest-mac.yml`). That is "nothing to install", not a crash.
 */

export function isMissingUpdateFeedError(error: unknown): boolean {
  const msg = errorText(error);
  if (!msg) return false;
  if (/cannot find [\w.-]+\.yml/i.test(msg)) return true;
  if (/HttpError:\s*404/i.test(msg) && /\.yml\b/i.test(msg)) return true;
  return false;
}

/**
 * The till lost its connection (Wi-Fi drop, router reboot). The next
 * scheduled check retries; nothing is broken.
 */
export function isOfflineUpdaterError(error: unknown): boolean {
  const msg = errorText(error);
  if (!msg) return false;
  return /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT|ABORTED)|TIMED_OUT|PROXY_CONNECTION_FAILED)\b|\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/.test(
    msg,
  );
}

/**
 * electron-updater hands every Mac download to Squirrel.Mac, which refuses
 * an app without a Developer ID signature. Ad-hoc builds install by swapping
 * the bundle instead, so this is expected there.
 */
export function isMacCodeSignatureError(error: unknown): boolean {
  return /could not get code signature for running application/i.test(
    errorText(error),
  );
}

export function userFacingUpdaterError(error: unknown): string {
  if (isMissingUpdateFeedError(error)) return 'No update available';
  if (isOfflineUpdaterError(error)) {
    return 'No internet connection. The till will check again later.';
  }
  const msg = errorText(error);
  const first = msg.split(/\r?\n/)[0]?.trim() || '';
  if (!first || first.length > 160 || /please double check/i.test(first)) {
    return 'Failed to check for updates';
  }
  return first;
}

function errorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  const anyE = error as { message?: unknown; stack?: unknown };
  return [anyE?.message, anyE?.stack, error]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}
