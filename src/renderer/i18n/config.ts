import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en/translation.json';
import sq from '../locales/sq/translation.json';
import { readStoredPosUiLang } from './locale';

const lng = typeof localStorage === 'undefined' ? 'en' : readStoredPosUiLang();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    sq: { translation: sq },
  },
  lng,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

if (typeof document !== 'undefined') {
  try {
    document.documentElement.lang = lng;
  } catch {
    // ignore
  }
}

export default i18n;
