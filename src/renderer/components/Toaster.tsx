import React from 'react';
import { useToastStore, type ToastLevel } from '../stores/toasts';

function bgFor(level: ToastLevel): string {
  if (level === 'success') return 'bg-emerald-700';
  if (level === 'info') return 'bg-blue-700';
  if (level === 'warn') return 'bg-amber-700';
  return 'bg-rose-700';
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  if (!toasts.length) return null;

  return (
    <div className="fixed top-3 left-3 right-3 sm:left-auto sm:right-4 sm:top-auto sm:bottom-4 sm:max-w-md z-50 space-y-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${bgFor(t.level)} text-white rounded-lg shadow-lg p-4 border border-white/10`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{t.title || 'Notice'}</div>
              <div className="text-sm opacity-95 mt-1 whitespace-pre-wrap break-words">
                {t.message}
              </div>
              {t.detail && (
                <details className="mt-2 text-xs opacity-95">
                  <summary className="cursor-pointer opacity-90 hover:opacity-100">
                    Details
                  </summary>
                  <div className="mt-1 whitespace-pre-wrap break-words">
                    {t.detail}
                  </div>
                </details>
              )}
            </div>
            <button
              className="px-2 py-1 rounded bg-black/20 hover:bg-black/30"
              onClick={() => remove(t.id)}
              aria-label="Dismiss"
              type="button"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

