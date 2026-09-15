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

export function userFacingUpdaterError(error: unknown): string {
  if (isMissingUpdateFeedError(error)) return 'No update available';
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
