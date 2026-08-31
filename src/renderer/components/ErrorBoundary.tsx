import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button, Card } from './ui';
import { IconAlert } from './icons';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * React Error Boundary to catch render errors and send to Sentry
 */
export class ErrorBoundary extends Component<Props, State> {
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

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log to Sentry if available
    if ((window as any).__sentry__) {
      try {
        (window as any).__sentry__.captureException(error, {
          contexts: {
            react: {
              componentStack: errorInfo.componentStack,
            },
          },
        });
      } catch (e) {
        // Sentry not initialized or failed
        console.error('[ErrorBoundary] Failed to report to Sentry', e);
      }
    }

    this.setState({
      error,
      errorInfo,
    });

    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    }
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
              <span className="mt-px shrink-0 text-rose-400">
                <IconAlert />
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
                this.setState({
                  hasError: false,
                  error: null,
                  errorInfo: null,
                });
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
