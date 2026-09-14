export const POS_UI_LANG_STORAGE_KEY = 'pos-ui-lang';

export function normalizeLng(v: unknown): 'en' | 'sq' {
  return String(v || '').toLowerCase() === 'sq' ? 'sq' : 'en';
}

export function readStoredPosUiLang(): 'en' | 'sq' {
  try {
    return normalizeLng(localStorage.getItem(POS_UI_LANG_STORAGE_KEY));
  } catch {
    return 'en';
  }
}

export function writeStoredPosUiLang(lng: 'en' | 'sq'): void {
  try {
    localStorage.setItem(POS_UI_LANG_STORAGE_KEY, lng);
  } catch {
    // private mode
  }
  try {
    document.documentElement.lang = lng;
  } catch {
    // ignore non-browser
  }
}
