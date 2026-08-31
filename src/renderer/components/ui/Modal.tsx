import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { Button } from './Button';
import { IconClose } from '../icons';

const WIDTH = {
  xs: 'max-w-xs',
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-4xl',
  full: 'max-w-[min(1100px,96vw)]',
} as const;

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Rendered in the footer, right aligned. */
  footer?: ReactNode;
  size?: keyof typeof WIDTH;
  /** Clicking the backdrop closes by default. */
  dismissable?: boolean;
  /** Body owns its padding (for tables / scroll regions). */
  flush?: boolean;
  className?: string;
  children?: ReactNode;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  dismissable = true,
  flush,
  className,
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissable]);

  if (!open) return null;

  return createPortal(
    <div className="pos-overlay">
      {dismissable ? (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="absolute inset-0 cursor-default"
          style={{ minHeight: 0 }}
          onClick={onClose}
        />
      ) : null}
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'pos-dialog relative flex max-h-[92dvh] flex-col',
          WIDTH[size],
          className,
        )}
      >
        {title ? (
          <div className="pos-dialog-header">
            <div className="min-w-0">
              <div className="pos-dialog-title truncate">{title}</div>
              {description ? (
                <div className="mt-0.5 text-[12px] text-gray-400">
                  {description}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="pos-icon-btn -mr-1 shrink-0"
            >
              <IconClose />
            </button>
          </div>
        ) : null}
        <div
          className={cn('min-h-0 flex-1 overflow-auto', !flush && 'px-4 py-4')}
        >
          {children}
        </div>
        {footer ? <div className="pos-dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Bottom sheet — the mobile counterpart of Modal. */
export function Sheet({
  open,
  onClose,
  title,
  actions,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex flex-col justify-end">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-[rgba(4,7,12,0.7)]"
        style={{ minHeight: 0 }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn('pos-sheet relative safe-pb', className)}
      >
        {title ? (
          <div className="pos-dialog-header">
            <div className="pos-dialog-title min-w-0 truncate">{title}</div>
            <div className="flex shrink-0 items-center gap-2">
              {actions}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="pos-icon-btn -mr-1"
              >
                <IconClose />
              </button>
            </div>
          </div>
        ) : null}
        <div className="max-h-[70vh] overflow-auto px-4 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Yes/no prompt. Replaces window.confirm and one-off modal markup. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy} className="max-sm:flex-1">
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            className="max-sm:flex-1"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body ? (
        <div className="text-[13px] leading-relaxed text-gray-300">{body}</div>
      ) : null}
    </Modal>
  );
}
