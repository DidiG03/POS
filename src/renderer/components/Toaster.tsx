import type { ReactNode } from 'react';
import { useToastStore, type ToastLevel } from '../stores/toasts';
import { IconButton, cn } from './ui';
import { IconAlert, IconCheck, IconClose, IconInfo } from './icons';

const EDGE: Record<ToastLevel, string> = {
  success: 'bg-emerald-400',
  info: 'bg-gray-300',
  warn: 'bg-amber-400',
  error: 'bg-rose-400',
};

const ACCENT: Record<ToastLevel, string> = {
  success: 'text-emerald-400',
  info: 'text-gray-300',
  warn: 'text-amber-300',
  error: 'text-rose-300',
};

function iconFor(level: ToastLevel): ReactNode {
  if (level === 'success') return <IconCheck />;
  if (level === 'info') return <IconInfo />;
  return <IconAlert />;
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  if (!toasts.length) return null;

  return (
    <div className="fixed top-3 left-3 right-3 sm:left-auto sm:right-4 sm:top-auto sm:bottom-4 sm:w-[360px] z-50 space-y-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="relative overflow-hidden rounded-lg border border-white/7 bg-gray-800 shadow-lg"
        >
          <span
            className={cn('absolute inset-y-0 left-0 w-0.5', EDGE[t.level])}
            aria-hidden
          />
          <div className="flex items-start gap-2.5 py-2.5 pl-3.5 pr-1.5">
            <span className={cn('mt-px shrink-0', ACCENT[t.level])}>
              {iconFor(t.level)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-gray-100">
                {t.title || 'Notice'}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-gray-400">
                {t.message}
              </div>
              {t.detail && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-gray-300">
                    Details
                  </summary>
                  <div className="pos-well mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] leading-relaxed text-gray-400">
                    {t.detail}
                  </div>
                </details>
              )}
            </div>
            <IconButton
              label="Dismiss"
              icon={<IconClose />}
              className="shrink-0"
              onClick={() => remove(t.id)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
