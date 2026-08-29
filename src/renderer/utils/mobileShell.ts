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

    // Status bar: white icons on the dark gray-900 app shell.
    // NOTE: Capacitor's Style enum is *backwards* from iOS naming conventions
    // — `Style.Dark` means "light/white content for a dark background" and
    // `Style.Light` means "dark/black content for a light background". We
    // want white icons over our dark background, so we pass Style.Dark.
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      try {
        await StatusBar.setStyle({ style: Style.Dark });
      } catch {
        /* ignore */
      }
      // Android only: paint the status bar to match the header.
      try {
        await StatusBar.setBackgroundColor({ color: '#111827' });
      } catch {
        /* ignore */
      }
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

    // Hide the splash screen now that the renderer is mounted.
    try {
      const { SplashScreen } = await import('@capacitor/splash-screen');
      try {
        await SplashScreen.hide({ fadeOutDuration: 200 });
      } catch {
        /* ignore */
      }
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}
