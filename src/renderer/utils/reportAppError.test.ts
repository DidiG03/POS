import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/toasts', () => ({
  toast: {
    fromError: vi.fn(),
  },
}));

vi.mock('./sentryBrowser', () => ({
  captureRendererException: vi.fn(),
}));

vi.mock('../i18n/config', () => ({
  default: { t: (key: string) => key },
}));

import { toast } from '../stores/toasts';
import { captureRendererException } from './sentryBrowser';
import {
  installUnhandledErrorToasts,
  isTransientNetworkError,
  reportAppError,
  resetReportAppErrorStateForTests,
  shouldIgnoreAppError,
} from './reportAppError';

describe('reportAppError', () => {
  afterEach(() => {
    resetReportAppErrorStateForTests();
    vi.mocked(toast.fromError).mockClear();
    vi.mocked(captureRendererException).mockClear();
  });

  it('ignores browser noise that is not an app failure', () => {
    expect(
      shouldIgnoreAppError(new Error('ResizeObserver loop limit exceeded')),
    ).toBe(true);
    expect(shouldIgnoreAppError(new Error('AbortError'))).toBe(true);
    expect(shouldIgnoreAppError('Script error.')).toBe(true);
    expect(
      shouldIgnoreAppError(new Error('Could not load this floor plan.')),
    ).toBe(false);
    expect(shouldIgnoreAppError({ status: 401, message: 'unauthorized' })).toBe(
      true,
    );
  });

  it('toasts unexpected errors and dedupes the same key', () => {
    const err = new Error('layout get failed');
    expect(
      reportAppError(err, { fallback: 'Could not load', key: 'layout.get' }),
    ).toBe(true);
    expect(
      reportAppError(err, { fallback: 'Could not load', key: 'layout.get' }),
    ).toBe(false);
    expect(toast.fromError).toHaveBeenCalledTimes(1);
    expect(toast.fromError).toHaveBeenCalledWith(err, 'Could not load', {
      title: undefined,
    });
    expect(captureRendererException).toHaveBeenCalledTimes(1);
  });

  it('installs unhandled rejection and error listeners once', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('window', {
      addEventListener: add,
      removeEventListener: remove,
    });
    const first = installUnhandledErrorToasts();
    const second = installUnhandledErrorToasts();
    expect(add).toHaveBeenCalledWith(
      'unhandledrejection',
      expect.any(Function),
    );
    expect(add).toHaveBeenCalledWith('error', expect.any(Function));
    const rejectionCalls = add.mock.calls.filter(
      (call) => call[0] === 'unhandledrejection',
    );
    expect(rejectionCalls).toHaveLength(1);
    second();
    first();
    vi.unstubAllGlobals();
  });
});

describe('transient LAN failures', () => {
  afterEach(() => {
    resetReportAppErrorStateForTests();
    vi.mocked(toast.fromError).mockClear();
  });

  it('recognises the transport errors restaurant Wi-Fi produces', () => {
    expect(isTransientNetworkError(new TypeError('Failed to fetch'))).toBe(
      true,
    );
    expect(isTransientNetworkError(new Error('Network request failed'))).toBe(
      true,
    );
    expect(isTransientNetworkError('Load failed')).toBe(true);
    expect(isTransientNetworkError(new Error('Table is closed'))).toBe(false);
  });

  it('still toasts one when a waiter deliberately tapped the action', () => {
    // The waiter tapped Send and it did not go out — silence would be worse
    // than a toast. Only the *global* handler filters these.
    expect(
      reportAppError(new TypeError('Failed to fetch'), {
        fallback: 'Try again',
        key: 'tickets.log',
      }),
    ).toBe(true);
    expect(toast.fromError).toHaveBeenCalledTimes(1);
  });

  it('does not toast a background poll that failed', () => {
    const listeners = new Map<string, (ev: any) => void>();
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: (ev: any) => void) =>
        listeners.set(name, fn),
      removeEventListener: () => undefined,
    });
    const uninstall = installUnhandledErrorToasts();

    listeners.get('unhandledrejection')?.({
      reason: new TypeError('Failed to fetch'),
    });
    expect(toast.fromError).not.toHaveBeenCalled();

    // A genuine bug still gets through.
    listeners.get('unhandledrejection')?.({
      reason: new Error('cannot read property of undefined'),
    });
    expect(toast.fromError).toHaveBeenCalledTimes(1);

    uninstall();
    vi.unstubAllGlobals();
  });
});
