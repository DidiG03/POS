import React, { useEffect, useState } from 'react';

type PrinterEvent = {
  level?: 'error' | 'warn' | 'info';
  kind?: string;
  message?: string;
  detail?: string;
  at?: number;
  context?: any;
};

export function PrinterNotification() {
  const [evt, setEvt] = useState<PrinterEvent | null>(null);

  useEffect(() => {
    const handle = (e: CustomEvent<PrinterEvent>) => {
      const d = e.detail || {};
      setEvt({
        level: d.level || 'error',
        kind: d.kind,
        message: d.message,
        detail: d.detail,
        at: d.at || Date.now(),
        context: d.context,
      });
    };
    window.addEventListener('printer:event', handle as EventListener);
    return () => window.removeEventListener('printer:event', handle as EventListener);
  }, []);

  if (!evt?.message) return null;

  const bg =
    evt.level === 'info'
      ? 'bg-blue-700'
      : evt.level === 'warn'
        ? 'bg-amber-700'
        : 'bg-rose-700';

  return (
    <div className={`fixed top-3 left-3 right-3 sm:left-auto sm:right-4 sm:top-auto sm:bottom-4 sm:max-w-md ${bg} text-white rounded-lg shadow-lg p-4 z-50`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Printer problem</div>
          <div className="text-sm opacity-95 mt-1">{evt.message}</div>
          {evt.detail && (
            <details className="mt-2 text-xs opacity-95">
              <summary className="cursor-pointer opacity-90 hover:opacity-100">Details</summary>
              <div className="mt-1 whitespace-pre-wrap break-words">{evt.detail}</div>
            </details>
          )}
        </div>
        <button className="px-2 py-1 rounded bg-black/20 hover:bg-black/30" onClick={() => setEvt(null)} aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}

