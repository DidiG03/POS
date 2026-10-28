import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../stores/toasts';

type PrinterEvent = {
  level?: 'error' | 'warn' | 'info';
  kind?: string;
  message?: string;
  detail?: string;
  at?: number;
  context?: any;
};

/** Toast title for a printer event; a recovery is good news, not a problem. */
export function printerEventTitleKey(d: PrinterEvent): string | null {
  if (d.kind === 'fiscal') return null;
  if (d.kind === 'recovered' || d.level === 'info') return 'printer.backTitle';
  if (d.kind === 'receipt') return 'printer.receiptTitle';
  if (d.kind) return 'printer.problemTitle';
  return 'printer.title';
}

export function PrinterNotification() {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
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
      const titleKey = printerEventTitleKey(d);
      const title = titleKey ? tRef.current(titleKey) : 'Fiskalizimi';
      if (level === 'info') toast.success(message, { title, detail });
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
