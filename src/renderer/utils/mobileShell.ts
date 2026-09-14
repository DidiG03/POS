// Bootstraps Capacitor-only behavior (status bar, splash) when the
// renderer is hosted inside a native iOS/Android shell. No-ops in
// the Electron app and in plain browsers.

export async function initMobileShell(): Promise<void> {
  try {
    const Cap = (
      window as unknown as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          getPlatform?: () => string;
        };
      }
    ).Capacitor;
    if (!Cap?.isNativePlatform?.()) return;

    // Tag the document so we can target Capacitor with CSS / debug tools.
    try {
      document.documentElement.dataset.shell = 'capacitor';
      const platform = Cap.getPlatform?.();
      if (platform) document.documentElement.dataset.platform = platform;
    } catch {
      // ignore
    }

    // Status bar tracks the POS theme. Capacitor's Style enum is inverted
    // from iOS names: Dark = white icons (dark chrome), Light = dark icons.
    try {
      const stored = (() => {
        try {
          const t = localStorage.getItem('pos-ui-theme');
          return t === 'light' || t === 'dark' ? t : 'dark';
        } catch {
          return 'dark';
        }
      })();
      await syncNativeChrome(stored);
    } catch {
      // plugin missing — ignore
    }

    // Hide the iOS keyboard shortcut bar (the row above the keyboard with
    // < > Done buttons). It causes loud `UIModernBarButton` auto-layout
    // warnings in the Xcode console and we don't need it inside a POS.
    try {
      const { Keyboard } = await import('@capacitor/keyboard');
      try {
        await Keyboard.setAccessoryBarVisible({ isVisible: false });
      } catch {
        /* ignore */
      }
    } catch {
      // plugin missing — ignore
    }

    // Light tap buzz on buttons / tappable controls.
    try {
      const { initButtonHaptics } = await import('./haptics');
      await initButtonHaptics();
    } catch {
      // ignore
    }

    // Never leave the native splash up if React is slow to become ready.
    window.setTimeout(() => {
      void hideMobileSplash();
    }, 8_000);
  } catch {
    // ignore
  }
}

export async function syncNativeChrome(theme: 'light' | 'dark'): Promise<void> {
  try {
    const Cap = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    if (!Cap?.isNativePlatform?.()) return;
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const light = theme === 'light';
    try {
      await StatusBar.setStyle({ style: light ? Style.Light : Style.Dark });
    } catch {
      /* ignore */
    }
    try {
      await StatusBar.setBackgroundColor({
        color: light ? '#f4f6fa' : '#0b1220',
      });
    } catch {
      /* ignore */
    }
  } catch {
    // plugin missing or not a native shell
  }
}

/** Hide splash after the first real UI (login, scan, or floor) is up. */
export async function hideMobileSplash(): Promise<void> {
  try {
    const Cap = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    if (!Cap?.isNativePlatform?.()) return;
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 180 });
  } catch {
    // ignore
  }
}
