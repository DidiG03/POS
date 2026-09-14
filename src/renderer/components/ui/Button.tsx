import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { SpinnerGlyph } from '../SpinnerGlyph';
import { cn } from './cn';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'danger-quiet';

export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'pos-btn-primary',
  secondary: 'pos-btn',
  ghost: 'pos-btn-ghost',
  danger: 'pos-danger-btn',
  'danger-quiet': 'pos-signout-btn',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-2.5 text-[12px] min-h-[var(--pos-control-h)]',
  md: '',
  lg: 'px-4 text-sm min-h-[var(--pos-control-h-lg)]',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. Sized by `.pos-icon`, so pass a bare svg. */
  icon?: ReactNode;
  /** Trailing icon or count. */
  trailing?: ReactNode;
  /** Stretch to the width of the parent. */
  block?: boolean;
  /** Shows a spinner and blocks interaction. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  trailing,
  block,
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        VARIANT[variant],
        SIZE[size],
        block && 'w-full',
        !children && 'px-0 aspect-square',
        className,
      )}
      {...rest}
    >
      {loading ? <SpinnerGlyph className="pos-icon" /> : icon}
      {children}
      {trailing}
    </button>
  );
}

/** Square, label-less button for toolbars and headers. */
export type IconButtonProps = Omit<ButtonProps, 'children' | 'block'> & {
  label: string;
};

export function IconButton({
  label,
  icon,
  className,
  variant,
  loading,
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      className={cn(
        variant ? VARIANT[variant] : 'pos-icon-btn',
        variant && 'px-0 aspect-square',
        className,
      )}
      {...rest}
    >
      {loading ? <SpinnerGlyph className="pos-icon" /> : icon}
    </button>
  );
}
