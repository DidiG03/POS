import * as Sentry from '@sentry/browser';
import { POS_SENTRY_DSN } from '@shared/sentryDsn';

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

/**
 * Capacitor / browser Waiter + Electron renderer JS errors.
 * Packaged / production builds send; Vite `npm run dev` does not (avoids noise).
 */
export function initRendererSentry(): void {
  const dsn = rendererDsn();
  if (!dsn) return;
  const w = window as Window & {
    __posSentryInit?: boolean;
    __sentry__?: typeof Sentry;
  };
  if (w.__posSentryInit) return;
  w.__posSentryInit = true;

  const dev = isDevBuild();
  try {
    Sentry.init({
      dsn,
      environment: dev ? 'development' : 'production',
      beforeSend(event) {
        if (dev) return null;
        return event;
      },
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
    w.__sentry__ = Sentry;
  } catch (e) {
    console.error('[Sentry] Renderer init failed', e);
  }
}

export function captureRendererException(
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  try {
    Sentry.captureException(toError(error), extra ? { extra } : undefined);
  } catch {
    // ignore
  }
}
