import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../components/ui/cn';
import { Switch } from '../../components/ui/Field';

export function IconKebab() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="pos-icon"
      aria-hidden
    >
      <circle cx="12" cy="5" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="12" cy="19" r="1.75" />
    </svg>
  );
}

export type KebabItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  hidden?: boolean;
};

/** Overflow menu for secondary / destructive settings actions. */
export function KebabMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: KebabItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const visible = items.filter((item) => !item.hidden);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const btn = rootRef.current?.querySelector('button');
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const menuW = 208;
      const menuH = menuRef.current?.offsetHeight || 8 * 40;
      let top = r.bottom + 6;
      if (top + menuH > window.innerHeight - 8) {
        top = Math.max(8, r.top - menuH - 6);
      }
      let left = r.right - menuW;
      if (left < 8) left = 8;
      if (left + menuW > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - menuW - 8);
      }
      setPos({ top, left });
    };
    place();
    const id = window.requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, visible.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      const inside = Boolean(
        target &&
          (rootRef.current?.contains(target) ||
            menuRef.current?.contains(target)),
      );
      if (!inside) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (visible.length === 0) return null;

  const menu = open ? (
    <div
      ref={menuRef}
      role="menu"
      style={
        pos
          ? { top: pos.top, left: pos.left, width: 208 }
          : { visibility: 'hidden', top: 0, left: 0, width: 208 }
      }
      className="fixed z-[80] overflow-hidden rounded-lg border border-white/10 bg-gray-900 py-1 shadow-lg"
    >
      {visible.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={cn(
            'w-full cursor-pointer px-3 py-2 text-left text-[13px] hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-50',
            item.danger
              ? 'text-rose-300 hover:bg-rose-500/10'
              : 'text-gray-100',
          )}
          onClick={() => {
            setOpen(false);
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="pos-icon-btn cursor-pointer"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <IconKebab />
      </button>
      {menu && typeof document !== 'undefined'
        ? createPortal(menu, document.body)
        : null}
    </div>
  );
}

export function SettingsHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-tight text-gray-50">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-gray-500">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsCard({
  title,
  description,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={cn(
        'overflow-visible rounded-lg border border-white/7 bg-[var(--pos-canvas)]',
        className,
      )}
    >
      {title != null || actions ? (
        <div className="flex items-start justify-between gap-3 border-b border-white/7 px-4 py-3">
          <div className="min-w-0">
            {title != null ? (
              <div className="text-[13px] font-semibold text-gray-100">
                {title}
              </div>
            ) : null}
            {description ? (
              <div className="mt-0.5 text-[12px] leading-relaxed text-gray-500">
                {description}
              </div>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : description && title == null ? (
        <div className="border-b border-white/7 px-4 py-3 text-[12px] leading-relaxed text-gray-500">
          {description}
        </div>
      ) : null}
      {children != null ? (
        <div className={cn(padded && 'p-4')}>{children}</div>
      ) : null}
    </section>
  );
}

export function SettingsToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  label,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-gray-100">{title}</div>
        {description ? (
          <div className="mt-0.5 text-[12px] leading-relaxed text-gray-500">
            {description}
          </div>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        label={label}
        disabled={disabled}
      />
    </div>
  );
}

export function SettingsStatus({
  children,
  tone = 'muted',
  className,
}: {
  children: ReactNode;
  tone?: 'ok' | 'error' | 'warn' | 'muted';
  className?: string;
}) {
  const color =
    tone === 'ok'
      ? 'text-emerald-300'
      : tone === 'error'
        ? 'text-rose-300'
        : tone === 'warn'
          ? 'text-amber-200'
          : 'text-gray-400';
  return (
    <div
      className={cn(
        'whitespace-pre-wrap text-[12px] leading-relaxed',
        color,
        className,
      )}
    >
      {children}
    </div>
  );
}
