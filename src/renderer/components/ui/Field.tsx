import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useId } from 'react';
import { cn } from './cn';
import { IconSearch } from '../icons';

/** Label + optional hint/error wrapper. Clones the id onto the control. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {label ? (
        <label className="pos-label mb-1.5 block" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <div className="mt-1.5 text-[12px] text-rose-300">{error}</div>
      ) : hint ? (
        <div className="pos-hint mt-1.5">{hint}</div>
      ) : null}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  /** Renders inside the field, before the text. */
  icon?: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

export function Input({ className, invalid, icon, ...rest }: InputProps) {
  if (icon) {
    return (
      <div className="relative min-w-0">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500">
          {icon}
        </span>
        <input
          className={cn(
            'pos-input pl-9',
            invalid && 'border-rose-500/60',
            className,
          )}
          {...rest}
        />
      </div>
    );
  }
  return (
    <input
      className={cn('pos-input', invalid && 'border-rose-500/60', className)}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  invalid,
  rows = 3,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      rows={rows}
      className={cn('pos-input', invalid && 'border-rose-500/60', className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  invalid,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}) {
  return (
    <select
      className={cn('pos-input', invalid && 'border-rose-500/60', className)}
      {...rest}
    >
      {children}
    </select>
  );
}

/** Search field with a leading icon and an optional clear affordance. */
export function SearchInput({
  value,
  onValueChange,
  className,
  placeholder,
  ...rest
}: Omit<InputProps, 'icon' | 'onChange' | 'value'> & {
  value: string;
  onValueChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <div className={cn('relative min-w-0', className)}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500">
        <IconSearch />
      </span>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        className="pos-input pl-9 [&::-webkit-search-cancel-button]:appearance-none"
        {...rest}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onValueChange('')}
          className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-gray-500 hover:bg-white/8 hover:text-gray-200"
          style={{ minHeight: 0 }}
          aria-label="Clear"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-[14px]"
            aria-hidden
          >
            <path
              d="M5 5l10 10M15 5 5 15"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/** Inline on/off control for settings rows. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{ minHeight: 0 }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50',
        checked ? 'border-white/20 bg-gray-50' : 'border-white/12 bg-gray-700',
        disabled && 'pointer-events-none opacity-45',
        className,
      )}
    >
      <span
        className={cn(
          'ml-0.5 size-4 rounded-full transition-transform duration-100',
          checked ? 'translate-x-4 bg-gray-900' : 'translate-x-0 bg-white',
        )}
      />
    </button>
  );
}
