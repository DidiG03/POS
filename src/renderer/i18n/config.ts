import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en/translation.json';
import { readStoredPosUiLang } from './locale';

const lng = typeof localStorage === 'undefined' ? 'en' : readStoredPosUiLang();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: lng === 'sq' ? 'en' : lng,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

if (typeof document !== 'undefined' && lng !== 'sq') {
  try {
    document.documentElement.lang = lng;
  } catch {
    // ignore
  }
}

export async function ensureLocaleResources(next: 'en' | 'sq'): Promise<void> {
  if (next !== 'sq') return;
  if (i18n.hasResourceBundle('sq', 'translation')) return;
  const mod = await import('../locales/sq/translation.json');
  const data =
    (mod as { default?: typeof en }).default ?? (mod as unknown as typeof en);
  i18n.addResourceBundle('sq', 'translation', data, true, true);
}

export default i18n;
