import type { ReactNode } from 'react';
import { cn } from './cn';

/** Bordered content block. Use `padded={false}` when the body owns its own
 * padding (tables, scroll regions). */
export function Card({
  className,
  padded = true,
  children,
}: {
  className?: string;
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-white/7 bg-gray-800',
        padded && 'p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Title row for a Card. Sits above a hairline when the card is unpadded. */
export function CardHeader({
  title,
  description,
  actions,
  className,
  divided = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  divided?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 px-4 py-3',
        divided && 'border-b border-white/7',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold tracking-tight text-gray-50">
          {title}
        </div>
        {description ? (
          <div className="mt-0.5 text-[12px] text-gray-400">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/** Page-level title block. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end justify-between gap-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold leading-tight tracking-tight text-gray-50">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-[13px] text-gray-400">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** Single metric tile. `tone` colours the value for at-a-glance scanning. */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'danger';
  className?: string;
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'danger'
          ? 'text-rose-300'
          : 'text-gray-50';
  return (
    <div className={cn('pos-stat', className)}>
      <div className="pos-stat-label truncate">{label}</div>
      <div className={cn('pos-stat-value truncate', toneClass)}>{value}</div>
      {hint ? (
        <div className="mt-1 truncate text-[12px] text-gray-500">{hint}</div>
      ) : null}
    </div>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('pos-section-label', className)}>{children}</div>;
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn('pos-divider', className)} />;
}

/** Placeholder for empty lists — never leave a panel blank. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-6' : 'px-6 py-12',
        className,
      )}
    >
      {icon ? (
        <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-white/7 bg-gray-800 text-gray-500">
          {icon}
        </div>
      ) : null}
      <div className="text-[13px] font-medium text-gray-300">{title}</div>
      {description ? (
        <div className="mt-1 max-w-xs text-[12px] text-gray-500">
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
