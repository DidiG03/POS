import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { SpinnerGlyph } from './SpinnerGlyph';

/**
 * Loading indicator. Logo + ring sit in the content well (below the header,
 * above the tab bar) so chrome stays put and every screen shares one position.
 */
export function PageSpinner({
  message = 'Loading…',
  detail,
  variant = 'fullPage',
  spinner = true,
  children,
}: {
  message?: string;
  detail?: string;
  variant?: 'fullPage' | 'overlay' | 'lock';
  spinner?: boolean;
  children?: ReactNode;
}) {
  const stack = (
    <div className="flex w-full max-w-md flex-col items-center gap-5">
      <BrandMark size="lg" />
      {spinner ? (
        <SpinnerGlyph className="size-6 text-[color:var(--pos-fg-muted)]" />
      ) : null}
      {message ? (
        <div className="text-center text-sm text-[color:var(--pos-fg)]">
          {message}
        </div>
      ) : null}
      {detail ? (
        <div className="text-center text-xs text-[color:var(--pos-fg-muted)]">
          {detail}
        </div>
      ) : null}
      {children}
    </div>
  );

  if (variant === 'lock') {
    return (
      <div
        className="pos-loader pos-loader--lock"
        role="alertdialog"
        aria-busy="true"
        aria-live="assertive"
        aria-modal="true"
      >
        {stack}
      </div>
    );
  }

  return (
    <div
      className="pos-loader"
      role="status"
      aria-busy={spinner}
      aria-live="polite"
    >
      {stack}
    </div>
  );
}
