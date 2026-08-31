import type { ReactNode } from 'react';
import { cn } from './cn';

export type SegmentedOption<T extends string | number> = {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Trailing count, rendered subdued. */
  count?: number;
  disabled?: boolean;
  title?: string;
};

/**
 * Grouped exclusive choice. Replaces loose rows of pill buttons so related
 * options read as one control.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
  block,
  size = 'md',
  ariaLabel,
}: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
  /** Split available width evenly across options. */
  block?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('pos-segmented', block && 'flex w-full', className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              'pos-segment',
              active && 'pos-segment--active',
              size === 'sm' && 'px-2 py-1 text-[12px]',
              block && 'flex-1',
              opt.disabled && 'pointer-events-none opacity-40',
            )}
          >
            {opt.icon}
            <span className="truncate">{opt.label}</span>
            {typeof opt.count === 'number' ? (
              <span
                className={cn(
                  'tabular text-[11px]',
                  active ? 'text-gray-400' : 'text-gray-500',
                )}
              >
                {opt.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
