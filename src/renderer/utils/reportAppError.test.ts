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
