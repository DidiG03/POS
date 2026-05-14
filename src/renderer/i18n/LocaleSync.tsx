import { type ReactNode, useEffect } from 'react';
import i18n from './config';

function normalizeLng(v: unknown): 'en' | 'sq' {
  return String(v || '').toLowerCase() === 'sq' ? 'sq' : 'en';
}

export function LocaleSync({ children }: { children: ReactNode }) {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const lng = normalizeLng(s?.preferences?.language);
        if (cancelled) return;
        await i18n.changeLanguage(lng);
        try {
          document.documentElement.lang = lng;
        } catch {
          // ignore non-browser
        }
      } catch {
        if (!cancelled) {
          await i18n.changeLanguage('en');
          try {
            document.documentElement.lang = 'en';
          } catch {
            // ignore
          }
        }
      }
    })();

    const onLocale = (ev: Event) => {
      const d = (ev as CustomEvent<{ lng?: string }>).detail;
      const lng = normalizeLng(d?.lng);
      void i18n.changeLanguage(lng);
      try {
        document.documentElement.lang = lng;
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:localeChanged', onLocale);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:localeChanged', onLocale);
    };
  }, []);

  return <>{children}</>;
}
