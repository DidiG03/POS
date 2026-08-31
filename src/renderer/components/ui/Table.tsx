import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { cn } from './cn';

/** Scroll container + hairline frame for a data table. */
export function TableFrame({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'min-w-0 overflow-auto rounded-lg border border-white/7',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Table({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <table className={cn('pos-table', className)}>{children}</table>;
}

export function Th({
  numeric,
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(numeric && 'text-right', className)}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({
  numeric,
  muted,
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={cn(
        numeric && 'pos-td-num',
        muted && 'text-gray-400',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
