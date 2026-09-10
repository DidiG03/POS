import { type ReactNode, useEffect } from 'react';
import { normalizePosUiTheme } from '@shared/uiTheme';
import { applyPosUiTheme } from '../theme';

export function ThemeSync({ children }: { children: ReactNode }) {
  useEffect(() => {
    if ((window as any).__KDS_APP__) return;
    let cancelled = false;
    void (async () => {
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        if (cancelled) return;
        applyPosUiTheme(normalizePosUiTheme(s?.preferences?.theme));
      } catch {
        // keep whatever bootPosUiTheme already applied
      }
    })();

    const onTheme = (ev: Event) => {
      const d = (ev as CustomEvent<{ theme?: string }>).detail;
      applyPosUiTheme(normalizePosUiTheme(d?.theme));
    };
    window.addEventListener('pos:themeChanged', onTheme);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:themeChanged', onTheme);
    };
  }, []);

  return <>{children}</>;
}
