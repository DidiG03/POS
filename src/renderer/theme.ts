import { useEffect, useState } from 'react';
import { normalizePosUiTheme, type PosUiTheme } from '@shared/uiTheme';

export const POS_UI_THEME_STORAGE_KEY = 'pos-ui-theme';

export function applyPosUiTheme(theme: PosUiTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.setAttribute('content', theme === 'light' ? '#f4f6fa' : '#0b1220');
  try {
    localStorage.setItem(POS_UI_THEME_STORAGE_KEY, theme);
  } catch {
    // private mode
  }
}

export function readStoredPosUiTheme(): PosUiTheme {
  try {
    return normalizePosUiTheme(localStorage.getItem(POS_UI_THEME_STORAGE_KEY));
  } catch {
    return 'dark';
  }
}

export function bootPosUiTheme(): void {
  applyPosUiTheme(readStoredPosUiTheme());
}

export function usePosUiTheme(): PosUiTheme {
  const [theme, setTheme] = useState<PosUiTheme>(() => {
    if (typeof document === 'undefined') return 'dark';
    return normalizePosUiTheme(document.documentElement.dataset.theme);
  });

  useEffect(() => {
    const sync = () =>
      setTheme(normalizePosUiTheme(document.documentElement.dataset.theme));
    const onTheme = (ev: Event) => {
      const d = (ev as CustomEvent<{ theme?: string }>).detail;
      setTheme(
        normalizePosUiTheme(d?.theme ?? document.documentElement.dataset.theme),
      );
    };
    window.addEventListener('pos:themeChanged', onTheme);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    sync();
    return () => {
      window.removeEventListener('pos:themeChanged', onTheme);
      mo.disconnect();
    };
  }, []);

  return theme;
}
