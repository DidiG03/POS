import * as Sentry from '@sentry/electron';
import { app } from 'electron';
import os from 'node:os';
import { POS_SENTRY_DSN } from '@shared/sentryDsn';

const IS_DEV =
  process.env.NODE_ENV !== 'production' || process.env.ELECTRON_IS_DEV === '1';

let enabled = false;

function resolveDsn(): string {
  return String(process.env.SENTRY_DSN || POS_SENTRY_DSN || '').trim();
}

export function initSentry(): void {
  const dsn = resolveDsn();
  if (!dsn) {
    console.log('[Sentry] Not initialized - no DSN');
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: IS_DEV ? 'development' : 'production',
      release: app.getVersion(),
      debug: IS_DEV && process.env.SENTRY_DEBUG === 'true',
      beforeSend(event, hint) {
        if (IS_DEV) {
          console.error('[Sentry Event (dev mode)]', {
            message: event.message,
            exception: event.exception,
            error: hint.originalException,
          });
          if (process.env.SENTRY_DEBUG !== 'true') {
            return null;
          }
        }
        return event;
      },
      tracesSampleRate: IS_DEV ? 1.0 : 0.1,
      initialScope: {
        tags: {
          platform: os.platform(),
          arch: os.arch(),
          electron_version: process.versions.electron,
          node_version: process.versions.node,
          app: 'pos-host',
        },
      },
      ignoreErrors: [
        'NetworkError',
        'Failed to fetch',
        'Network request failed',
        'User cancelled',
        'User canceled',
        /Extension context invalidated/,
        /ResizeObserver loop/,
      ],
      maxBreadcrumbs: IS_DEV ? 100 : 50,
    });
    enabled = true;
    console.log('[Sentry] Initialized successfully');
  } catch (error) {
    enabled = false;
    console.error('[Sentry] Initialization failed', error);
  }
}

export function setSentryUser(
  userId: number | null,
  displayName?: string,
  role?: string,
): void {
  if (!enabled) return;
  try {
    Sentry.setUser(
      userId ? { id: String(userId), username: displayName, role } : null,
    );
  } catch (error) {
    console.error('[Sentry] Failed to set user', error);
  }
}

export function addBreadcrumb(
  message: string,
  category?: string,
  level: Sentry.SeverityLevel = 'info',
): void {
  if (!enabled) return;
  try {
    Sentry.addBreadcrumb({
      message,
      category: category || 'user',
      level,
      timestamp: Date.now() / 1000,
    });
  } catch {
    // Don't log breadcrumb errors
  }
}

export function captureException(
  error: Error,
  context?: Record<string, any>,
): void {
  if (!enabled) {
    if (IS_DEV) {
      console.error('[Exception (Sentry disabled)]', error, context);
    }
    return;
  }
  try {
    Sentry.captureException(error, {
      extra: context,
    });
  } catch (e) {
    console.error('[Sentry] Failed to capture exception', e);
  }
}

export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
): void {
  if (!enabled) {
    if (IS_DEV) {
      console.log(`[${level.toUpperCase()} (Sentry disabled)]`, message);
    }
    return;
  }
  try {
    Sentry.captureMessage(message, level);
  } catch (error) {
    console.error('[Sentry] Failed to capture message', error);
  }
}

export const sentryEnabled = () => enabled;
