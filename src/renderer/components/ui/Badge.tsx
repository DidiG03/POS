import type { ReactNode } from 'react';
import { cn } from './cn';

export type Tone = 'neutral' | 'accent' | 'warn' | 'danger' | 'info';

const TONE: Record<Tone, string> = {
  neutral: '',
  accent: 'pos-badge--accent',
  warn: 'pos-badge--warn',
  danger: 'pos-badge--danger',
  info: 'pos-badge--info',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-gray-500',
  accent: 'bg-emerald-400',
  warn: 'bg-amber-400',
  danger: 'bg-rose-400',
  info: 'bg-sky-400',
};

export function Badge({
  tone = 'neutral',
  dot,
  className,
  children,
}: {
  tone?: Tone;
  /** Leading status dot. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn('pos-badge', TONE[tone], className)}>
      {dot ? <span className={cn('pos-dot', DOT[tone])} /> : null}
      {children}
    </span>
  );
}

/** Bare status dot, for tables and dense rows. */
export function StatusDot({
  tone = 'neutral',
  label,
  className,
}: {
  tone?: Tone;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn('pos-dot', DOT[tone], className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
    />
  );
}

/** Header chip for connectivity / sync state. */
export function StatusChip({
  tone = 'neutral',
  className,
  children,
  title,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={cn('pos-status-chip', className)} title={title}>
      <span className={cn('pos-dot', DOT[tone])} />
      {children}
    </span>
  );
}
