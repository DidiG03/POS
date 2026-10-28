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

    // The on-screen keyboard must not cover the field being typed in (an
    // item note sat under it). Edge-to-edge Android does not always resize
    // the WebView, so the keyboard height pads the page and the focused
    // field is scrolled into view.
    try {
      installKeyboardAvoidance(
        (await import('@capacitor/keyboard')).Keyboard as any,
      );
    } catch {
      // plugin missing — the focus scroll below still helps
      installKeyboardAvoidance(null);
    }

    // Android Back moves around the app instead of closing it mid-order.
    if (Cap.getPlatform?.() === 'android') {
      try {
        const { installNativeBackButton } = await import('./nativeBack');
        await installNativeBackButton();
      } catch {
        // plugin missing (app built before `cap sync`) — ignore
      }
    }

    // Haptics for important outcomes (toasts), not every control tap.
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
        color: light ? '#f2f2f7' : '#0b1220',
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

function isTextField(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = String((el as HTMLInputElement).type || 'text');
  return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
}

function revealFocused(): void {
  const el = document.activeElement;
  if (!isTextField(el)) return;
  try {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    el.scrollIntoView();
  }
}

export function installKeyboardAvoidance(
  keyboard: {
    addListener: (
      name: string,
      cb: (info: { keyboardHeight?: number }) => void,
    ) => unknown;
  } | null,
): void {
  const root = document.documentElement;
  document.addEventListener('focusin', (e) => {
    if (!isTextField(e.target)) return;
    // After the keyboard has animated in.
    window.setTimeout(revealFocused, 320);
  });
  if (!keyboard) return;
  try {
    void keyboard.addListener('keyboardDidShow', (info) => {
      const h = Math.max(0, Number(info?.keyboardHeight) || 0);
      root.style.setProperty('--pos-keyboard-h', `${h}px`);
      root.dataset.keyboard = 'open';
      revealFocused();
    });
    void keyboard.addListener('keyboardDidHide', () => {
      root.style.setProperty('--pos-keyboard-h', '0px');
      delete root.dataset.keyboard;
    });
  } catch {
    // ignore
  }
}
