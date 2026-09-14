import i18n from '../i18n/config';
import { toast } from '../stores/toasts';
import { captureRendererException } from './sentryBrowser';

const DEDUPE_MS = 8_000;
const recent = new Map<string, number>();

const IGNORE = [
  /ResizeObserver loop/i,
  /^AbortError\b/i,
  /\bThe operation was aborted\b/i,
  /\bThe user aborted a request\b/i,
  /^Script error\.?$/i,
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-extension:\/\//i,
];

function errorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error.trim();
  const anyE = error as { name?: unknown; message?: unknown; stack?: unknown };
  return [anyE?.name, anyE?.message, anyE?.stack]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

export function shouldIgnoreAppError(error: unknown): boolean {
  const anyE = error as { name?: unknown; message?: unknown } | null;
  const parts = [
    errorText(error),
    typeof error === 'string' ? error : '',
    String(anyE?.name || ''),
    String(anyE?.message || ''),
  ];
  return parts.some(
    (text) => Boolean(text.trim()) && IGNORE.some((re) => re.test(text)),
  );
}

function prune(now: number) {
  if (recent.size < 40) return;
  for (const [key, at] of recent) {
    if (now - at > DEDUPE_MS) recent.delete(key);
  }
}

/**
 * Surface an unexpected failure as an error toast.
 * Dedupes identical keys so polling / retries do not spam.
 * Returns whether a toast was shown.
 */
export function reportAppError(
  error: unknown,
  opts?: {
    fallback?: string;
    title?: string;
    key?: string;
    extra?: Record<string, unknown>;
  },
): boolean {
  if (shouldIgnoreAppError(error)) return false;
  const fallback = String(opts?.fallback || i18n.t('common.toastError')).trim();
  const key = String(opts?.key || errorText(error) || fallback).slice(0, 240);
  const now = Date.now();
  const prev = recent.get(key);
  if (prev && now - prev < DEDUPE_MS) return false;
  recent.set(key, now);
  prune(now);
  toast.fromError(error, fallback, { title: opts?.title });
  captureRendererException(error, {
    toastKey: key,
    ...(opts?.extra || {}),
  });
  return true;
}

export function resetReportAppErrorStateForTests() {
  recent.clear();
}

export function installUnhandledErrorToasts(): () => void {
  const w = window as Window & { __posUnhandledErrorToasts?: boolean };
  if (w.__posUnhandledErrorToasts) return () => undefined;
  w.__posUnhandledErrorToasts = true;

  const onRejection = (ev: PromiseRejectionEvent) => {
    reportAppError(ev.reason);
  };
  const onError = (ev: ErrorEvent) => {
    if (ev.defaultPrevented) return;
    const target = ev.target;
    if (target && target !== window) return;
    reportAppError(ev.error || ev.message);
  };

  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('error', onError);
  return () => {
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('error', onError);
    w.__posUnhandledErrorToasts = false;
  };
}
