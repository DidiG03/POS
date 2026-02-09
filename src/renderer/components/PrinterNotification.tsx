import { useEffect, useRef } from 'react';
import { toast } from '../stores/toasts';

type PrinterEvent = {
  level?: 'error' | 'warn' | 'info';
  kind?: string;
  message?: string;
  detail?: string;
  at?: number;
  context?: any;
};

export function PrinterNotification() {
  const lastKeyRef = useRef<string>('');
  const lastAtRef = useRef<number>(0);

  useEffect(() => {
    const handle = (e: CustomEvent<PrinterEvent>) => {
      const d = e.detail || {};
      const level = d.level || 'error';
      const message = d.message ? String(d.message) : '';
      const detail = d.detail ? String(d.detail) : undefined;
      const key =
        `${String(d.kind || '')}|${message}|${String(detail || '')}`.slice(
          0,
          500,
        );
      const at = Number(d.at || Date.now());

      // Deduplicate bursts (same printer failure can be reported multiple times quickly)
      if (key && key === lastKeyRef.current && at - lastAtRef.current < 1500)
        return;
      lastKeyRef.current = key;
      lastAtRef.current = at;

      if (!message) return;
      const title = d.kind ? 'Printer problem' : 'Printer';
      if (level === 'info') toast.info(message, { title, detail });
      else if (level === 'warn') toast.warn(message, { title, detail });
      else toast.error(message, { title, detail });
    };
    window.addEventListener('printer:event', handle as EventListener);
    return () =>
      window.removeEventListener('printer:event', handle as EventListener);
  }, []);

  // We now render printer errors via the shared toast system.
  return null;
}
