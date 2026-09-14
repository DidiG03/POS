export type LanLoginErrorKind = 'pairing' | 'host' | 'invalid_pin' | 'other';

function errorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  const anyE = error as { name?: unknown; message?: unknown } | null;
  return [anyE?.name, anyE?.message, error]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

export function isLanNetworkError(error: unknown): boolean {
  if (error == null) return false;
  if (typeof TypeError !== 'undefined' && error instanceof TypeError)
    return true;
  const anyE = error as { name?: unknown; status?: unknown } | null;
  const name = String(anyE?.name || '');
  if (name === 'AbortError' || name === 'TimeoutError' || name === 'TypeError')
    return true;
  const status = Number(anyE?.status);
  if (status === 502 || status === 503 || status === 504) return true;
  return /failed to fetch|network request failed|load failed|networkerror|err_connection|econnrefused|enotfound|etimedout|the internet connection appears to be offline|could not connect|host unreachable|pos host unreachable/i.test(
    errorText(error),
  );
}

export function isPairingRejectedError(error: unknown): boolean {
  if (isLanNetworkError(error)) return false;
  const msg = errorText(error).toLowerCase();
  if (!/pairing/.test(msg)) return false;
  const status = Number((error as { status?: unknown } | null)?.status);
  return (
    !Number.isFinite(status) || status === 0 || status === 401 || status === 403
  );
}

export function classifyLanLoginError(error: unknown): LanLoginErrorKind {
  if (error == null) return 'other';
  if (isLanNetworkError(error)) return 'host';
  if (isPairingRejectedError(error)) return 'pairing';
  const msg = errorText(error).toLowerCase();
  if (/invalid pin|wrong pin|incorrect pin/.test(msg)) return 'invalid_pin';
  return 'other';
}

export function lanLoginErrorCopyKey(
  kind: LanLoginErrorKind,
):
  | 'login.pairingRequired'
  | 'login.hostUnavailable'
  | 'login.invalidPin'
  | 'login.loginFailed' {
  if (kind === 'host') return 'login.hostUnavailable';
  if (kind === 'pairing') return 'login.pairingRequired';
  if (kind === 'invalid_pin') return 'login.invalidPin';
  return 'login.loginFailed';
}

/** Short server/client reason, never a stack or raw network noise. */
export function humanLoginDetail(error: unknown): string {
  const anyE = error as { message?: unknown; status?: unknown } | null;
  const message = String(
    anyE?.message || (typeof error === 'string' ? error : '') || '',
  )
    .replace(/^Error:\s*/i, '')
    .trim();
  if (!message || isLanNetworkError(error)) return '';
  const status = Number(anyE?.status);
  const withStatus =
    Number.isFinite(status) &&
    status >= 400 &&
    !message.startsWith(String(status))
      ? `${status} ${message}`
      : message;
  return withStatus.slice(0, 180);
}

type LoginCopy = (key: string, opts?: { detail?: string }) => string;

/** User-facing login copy. Known cases get a fixed sentence; anything else
 *  still shows the underlying reason so the error banner is never empty. */
export function lanLoginUserMessage(error: unknown, t: LoginCopy): string {
  const kind = classifyLanLoginError(error);
  if (kind === 'host') return t('login.hostUnavailable');
  if (kind === 'pairing') return t('login.pairingRequired');
  if (kind === 'invalid_pin') return t('login.invalidPin');
  const detail = humanLoginDetail(error);
  const lower = detail.toLowerCase();
  if (/lan disabled/.test(lower)) return t('login.lanDisabled');
  if (/web access disabled/.test(lower)) return t('login.webAccessDisabled');
  if (detail) return t('login.loginFailedDetail', { detail });
  return t('login.loginFailed');
}
