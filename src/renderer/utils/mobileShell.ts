// Bootstraps Capacitor-only behavior (status bar, splash) when the
// renderer is hosted inside a native iOS/Android shell. No-ops in
// the Electron app and in plain browsers.

export async function initMobileShell(): Promise<void> {
  try {
    const Cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
    if (!Cap?.isNativePlatform?.()) return;

    // Tag the document so we can target Capacitor with CSS / debug tools.
    try {
      document.documentElement.dataset.shell = 'capacitor';
      const platform = Cap.getPlatform?.();
      if (platform) document.documentElement.dataset.platform = platform;
    } catch {
      // ignore
    }

    // Status bar: light icons (Style.Light = "light content") on dark
    // background, matching the gray-900 app shell.
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      try { await StatusBar.setStyle({ style: Style.Light }); } catch { /* ignore */ }
      // Android only: paint the status bar to match the header.
      try { await StatusBar.setBackgroundColor({ color: '#111827' }); } catch { /* ignore */ }
    } catch {
      // plugin missing — ignore
    }

    // Hide the iOS keyboard shortcut bar (the row above the keyboard with
    // < > Done buttons). It causes loud `UIModernBarButton` auto-layout
    // warnings in the Xcode console and we don't need it inside a POS.
    try {
      const { Keyboard } = await import('@capacitor/keyboard');
      try { await Keyboard.setAccessoryBarVisible({ isVisible: false }); } catch { /* ignore */ }
    } catch {
      // plugin missing — ignore
    }

    // Hide the splash screen now that the renderer is mounted.
    try {
      const { SplashScreen } = await import('@capacitor/splash-screen');
      try { await SplashScreen.hide({ fadeOutDuration: 200 }); } catch { /* ignore */ }
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}
