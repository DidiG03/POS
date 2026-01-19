/**
 * Sentry error tracking configuration
 * 
 * To enable Sentry, set SENTRY_DSN in your .env file or environment variables.
 * Get your DSN from https://sentry.io/ → Your Project → Settings → Client Keys (DSN)
 * 
 * For development, Sentry will be disabled unless SENTRY_DSN is set.
 * In production, it's recommended to always set SENTRY_DSN.
 */

import * as Sentry from '@sentry/electron';
import { app } from 'electron';
import os from 'node:os';

const DSN = process.env.SENTRY_DSN || '';
const ENABLED = Boolean(DSN && DSN.trim().length > 0);
const IS_DEV = process.env.NODE_ENV !== 'production' || process.env.ELECTRON_IS_DEV === '1';

export function initSentry(): void {
  if (!ENABLED) {
    console.log('[Sentry] Not initialized - SENTRY_DSN not set');
    return;
  }

  try {
    Sentry.init({
      dsn: DSN,
      environment: IS_DEV ? 'development' : 'production',
      release: app.getVersion(),
      // Enable debug in development to see what's being sent
      debug: IS_DEV && process.env.SENTRY_DEBUG === 'true',
      
      // Only send errors in production; in dev, log to console
      beforeSend(event, hint) {
        if (IS_DEV) {
          console.error('[Sentry Event (dev mode)]', {
            message: event.message,
            exception: event.exception,
            error: hint.originalException,
          });
          // In development, return null to prevent sending
          // Set SENTRY_DEBUG=true to see what would be sent
          if (process.env.SENTRY_DEBUG !== 'true') {
            return null;
          }
        }
        return event;
      },

      // Configure sample rate (1.0 = 100% of events)
      tracesSampleRate: IS_DEV ? 1.0 : 0.1,

      // Add useful context
      initialScope: {
        tags: {
          platform: os.platform(),
          arch: os.arch(),
          electron_version: process.versions.electron,
          node_version: process.versions.node,
        },
      },

      // Ignore common errors that aren't actionable
      ignoreErrors: [
        // Network errors that are handled
        'NetworkError',
        'Failed to fetch',
        'Network request failed',
        // User cancellation
        'User cancelled',
        'User canceled',
        // Browser extension errors (not our code)
        /Extension context invalidated/,
        // ResizeObserver errors (known browser issue)
        /ResizeObserver loop/,
      ],

      // Don't send breadcrumbs for console logs in production (privacy)
      maxBreadcrumbs: IS_DEV ? 100 : 50,
    });

    console.log('[Sentry] Initialized successfully');
  } catch (error) {
    console.error('[Sentry] Initialization failed', error);
  }
}

/**
 * Set user context (call after login)
 */
export function setSentryUser(userId: number | null, displayName?: string, role?: string): void {
  if (!ENABLED) return;
  try {
    Sentry.setUser(userId ? { id: String(userId), username: displayName, role } : null);
  } catch (error) {
    console.error('[Sentry] Failed to set user', error);
  }
}

/**
 * Add breadcrumb (useful for debugging user actions)
 */
export function addBreadcrumb(message: string, category?: string, level: Sentry.SeverityLevel = 'info'): void {
  if (!ENABLED) return;
  try {
    Sentry.addBreadcrumb({
      message,
      category: category || 'user',
      level,
      timestamp: Date.now() / 1000,
    });
  } catch (error) {
    // Don't log breadcrumb errors
  }
}

/**
 * Capture an exception manually
 */
export function captureException(error: Error, context?: Record<string, any>): void {
  if (!ENABLED) {
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

/**
 * Capture a message manually
 */
export function captureMessage(message: string, level: Sentry.SeverityLevel = 'info'): void {
  if (!ENABLED) {
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

export const sentryEnabled = ENABLED;
