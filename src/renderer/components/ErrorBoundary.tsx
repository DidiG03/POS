import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from './ui/Button';
import { Card } from './ui/Surface';
import { emitPosSyncCatchup } from '../utils/posReadCache';
import { reportAppError } from '../utils/reportAppError';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

const RECOVER_KEY = 'pos-error-boundary-recover-at';
const RECOVER_MS = 8_000;

function recentlyRecovered(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(RECOVER_KEY) || 0);
    return Number.isFinite(at) && now - at < RECOVER_MS;
  } catch {
    return false;
  }
}

function markRecovered(now = Date.now()): void {
  try {
    sessionStorage.setItem(RECOVER_KEY, String(now));
  } catch {
    // ignore
  }
}

/**
 * React Error Boundary to catch render errors and send to Sentry
 */
export class ErrorBoundary extends Component<Props, State> {
  private recoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidMount() {
    window.addEventListener('pos:syncCatchup', this.onSyncCatchup);
  }

  componentWillUnmount() {
    window.removeEventListener('pos:syncCatchup', this.onSyncCatchup);
    if (this.recoverTimer != null) clearTimeout(this.recoverTimer);
  }

  onSyncCatchup = () => {
    if (!this.state.hasError) return;
    if (recentlyRecovered()) return;
    this.clearError();
  };

  clearError = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({
      error,
      errorInfo,
    });

    reportAppError(error, {
      key: 'react.render',
      extra: { componentStack: errorInfo.componentStack },
    });

    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    }

    if (recentlyRecovered()) return;
    markRecovered();
    this.recoverTimer = setTimeout(() => {
      this.clearError();
      try {
        emitPosSyncCatchup();
      } catch {
        // ignore
      }
    }, 50);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div className="pos-app pos-app--auth flex min-h-screen flex-col items-center justify-center p-6">
          <Card className="w-full max-w-md">
            <div className="flex items-start gap-3">
              <span className="mt-px shrink-0 text-rose-400" aria-hidden>
                <svg
                  className="pos-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold tracking-tight text-gray-50">
                  Something went wrong
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-gray-400">
                  The application encountered an unexpected error. Please try
                  refreshing the page or contact support if the problem
                  persists.
                </p>
              </div>
            </div>
            {process.env.NODE_ENV !== 'production' && this.state.error && (
              <details className="mt-4">
                <summary className="cursor-pointer text-[12px] font-medium text-gray-500 hover:text-gray-300">
                  Error details (dev only)
                </summary>
                <pre className="pos-well mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-[11px] leading-relaxed text-gray-400">
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}
            <Button
              variant="primary"
              block
              className="mt-4"
              onClick={() => {
                this.clearError();
                try {
                  emitPosSyncCatchup();
                } catch {
                  // ignore
                }
              }}
            >
              Try again
            </Button>
            <Button
              variant="secondary"
              block
              className="mt-2"
              onClick={() => {
                this.clearError();
                window.location.reload();
              }}
            >
              Reload Application
            </Button>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
