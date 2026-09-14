/** Shared loading ring — same glyph for page, overlay, lock, and buttons. */
export function SpinnerGlyph({ className = 'size-6' }: { className?: string }) {
  return <div className={`pos-spinner ${className}`} aria-hidden />;
}
