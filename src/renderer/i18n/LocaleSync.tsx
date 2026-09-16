import { type ReactNode, useEffect } from 'react';
import i18n, { ensureLocaleResources } from './config';
import { normalizeLng, writeStoredPosUiLang } from './locale';

async function applyLng(lng: 'en' | 'sq') {
  await ensureLocaleResources(lng);
  await i18n.changeLanguage(lng);
  writeStoredPosUiLang(lng);
}

export function LocaleSync({ children }: { children: ReactNode }) {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        const lng = normalizeLng(s?.preferences?.language);
        if (cancelled) return;
        await applyLng(lng);
      } catch {
        if (!cancelled) await applyLng('en');
      }
    })();

    const onLocale = (ev: Event) => {
      const d = (ev as CustomEvent<{ lng?: string }>).detail;
      void applyLng(normalizeLng(d?.lng));
    };
    window.addEventListener('pos:localeChanged', onLocale);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:localeChanged', onLocale);
    };
  }, []);

  return <>{children}</>;
}
