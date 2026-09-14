import { type ReactNode, useEffect } from 'react';
import { applyHostPosUiTheme } from '../theme';

export function ThemeSync({ children }: { children: ReactNode }) {
  useEffect(() => {
    if ((window as any).__KDS_APP__) return;
    let cancelled = false;
    let inflight: Promise<void> | null = null;
    const pullHostTheme = () => {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const s: any = await window.api.settings.get().catch(() => null);
          if (cancelled) return;
          applyHostPosUiTheme(s?.preferences?.theme);
        } catch {
          // keep whatever bootPosUiTheme already applied
        }
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    };
    void pullHostTheme();

    const onTheme = (ev: Event) => {
      applyHostPosUiTheme(
        (ev as CustomEvent<{ theme?: string }>).detail?.theme,
      );
    };
    window.addEventListener('pos:themeChanged', onTheme);
    // Catchup already dropped the settings cache. One live get is enough.
    window.addEventListener('pos:syncCatchup', pullHostTheme);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:themeChanged', onTheme);
      window.removeEventListener('pos:syncCatchup', pullHostTheme);
    };
  }, []);

  return <>{children}</>;
}
