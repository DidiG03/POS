import { POS_SENTRY_DSN } from '@shared/sentryDsn';

/**
 * Only the two calls we make. Holding the whole `@sentry/browser` namespace
 * (or leaking it onto `window`) keeps Replay, Feedback and Replay-Canvas
 * reachable, which is ~240 kB of the chunk we never use.
 */
type SentryApi = {
  captureException: (
    error: Error,
    hint?: { extra?: Record<string, unknown> },
  ) => void;
};

let sentry: SentryApi | null = null;
let loading: Promise<SentryApi | null> | null = null;
const queued: Array<{ error: unknown; extra?: Record<string, unknown> }> = [];

function rendererDsn(): string {
  const fromEnv = String(
    (import.meta as { env?: { VITE_SENTRY_DSN?: string } }).env
      ?.VITE_SENTRY_DSN || '',
  ).trim();
  return fromEnv || POS_SENTRY_DSN;
}

function isDevBuild(): boolean {
  return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
}

function wantsLiteNetwork(): boolean {
  try {
    const c = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    if (!c) return false;
    if (c.saveData) return true;
    return c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
  } catch {
    return false;
  }
}

function shellTag(): string {
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  if (cap?.isNativePlatform?.()) return 'capacitor';
  if ((window as { __BROWSER_CLIENT__?: boolean }).__BROWSER_CLIENT__)
    return 'tablet';
  if (/electron/i.test(navigator.userAgent)) return 'electron';
  return 'web';
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  const msg = String(
    (error as { message?: unknown } | null)?.message ||
      error ||
      'Unknown error',
  ).trim();
  return new Error(msg || 'Unknown error');
}

function flushQueued(api: SentryApi) {
  while (queued.length) {
    const item = queued.shift();
    if (!item) break;
    try {
      api.captureException(
        toError(item.error),
        item.extra ? { extra: item.extra } : undefined,
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Capacitor / browser Waiter + Electron renderer JS errors.
 * Packaged / production builds send. Vite `npm run dev` never downloads
 * `@sentry/browser` (~2MB) onto the PIN screen. Slow / Save-Data links skip it.
 */
export function initRendererSentry(): void {
  const dsn = rendererDsn();
  if (!dsn) return;
  if (isDevBuild() || wantsLiteNetwork()) return;
  const w = window as Window & { __posSentryInit?: boolean };
  if (w.__posSentryInit) return;
  w.__posSentryInit = true;

  loading = import('@sentry/browser')
    .then(({ init, captureException }) => {
      try {
        init({
          dsn,
          environment: 'production',
          ignoreErrors: [
            'NetworkError',
            'Failed to fetch',
            'Network request failed',
            'User cancelled',
            'User canceled',
            /Extension context invalidated/,
            /ResizeObserver loop/,
            /^AbortError\b/,
            /The operation was aborted/,
          ],
          initialScope: {
            tags: {
              shell: shellTag(),
            },
          },
        });
        const api: SentryApi = { captureException };
        sentry = api;
        flushQueued(api);
        return api;
      } catch (e) {
        console.error('[Sentry] Renderer init failed', e);
        return null;
      }
    })
    .catch((e) => {
      console.error('[Sentry] Renderer load failed', e);
      return null;
    });
}

export function captureRendererException(
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  if (isDevBuild()) return;
  try {
    if (sentry) {
      sentry.captureException(toError(error), extra ? { extra } : undefined);
      return;
    }
    if (queued.length < 20) queued.push({ error, extra });
    if (loading) {
      void loading.then((mod) => {
        if (mod && queued.length) flushQueued(mod);
      });
    }
  } catch {
    // ignore
  }
}
