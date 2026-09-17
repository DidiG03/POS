// Tablet (Capacitor) haptic feedback. No-ops in Electron and the browser.
//
// Only important outcomes buzz (toasts, or an explicit data-haptic). Every
// button used to fire on pointerdown + touchstart, which felt like the
// whole phone was vibrating.
//
// Android WebView often labels finger presses as pointerType "mouse", and
// Capacitor's Haptics.impact() waveforms are ignored on several Samsung
// tablets. We therefore:
//   1. Prefer the synchronous PosNativeHaptics Java bridge on Android.
//   2. Fall back to Haptics.vibrate() / Haptics.impact() for iOS.

import { Haptics, ImpactStyle } from '@capacitor/haptics';

export type HapticKind = 'light' | 'medium' | 'heavy';

const OPT_IN_SELECTOR = '[data-haptic]:not([data-haptic="off"])';

const MIN_GAP_MS = 80;

let started = false;
let lastAt = 0;
let pluginReady = false;

type NativeHapticsBridge = { tap?: () => void };

function nativeBridge(): NativeHapticsBridge | null {
  const bridge = (
    window as unknown as { PosNativeHaptics?: NativeHapticsBridge }
  ).PosNativeHaptics;
  return bridge && typeof bridge.tap === 'function' ? bridge : null;
}

function isNativeShell(): boolean {
  const cap = (
    window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        getPlatform?: () => string;
      };
    }
  ).Capacitor;
  if (!cap) return false;
  try {
    if (cap.isNativePlatform?.()) return true;
  } catch {
    // ignore
  }
  const platform = cap.getPlatform?.();
  return platform === 'ios' || platform === 'android';
}

export function findHapticTarget(start: EventTarget | null): Element | null {
  if (!(start instanceof Element)) return null;
  const el = start.closest(OPT_IN_SELECTOR);
  if (!el) return null;
  if (el.getAttribute('aria-disabled') === 'true') return null;
  if (
    el instanceof HTMLButtonElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLOptionElement
  ) {
    if (el.disabled) return null;
  }
  if (el.hasAttribute('disabled')) return null;
  return el;
}

function kindFor(el: Element): HapticKind {
  const raw = (el.getAttribute('data-haptic') || 'medium').toLowerCase();
  if (raw === 'light' || raw === 'heavy') return raw;
  return 'medium';
}

export function haptic(kind: HapticKind = 'medium'): void {
  if (typeof window === 'undefined' || !isNativeShell()) return;
  const now = Date.now();
  if (now - lastAt < MIN_GAP_MS) return;
  lastAt = now;

  const native = nativeBridge();
  if (native?.tap) {
    try {
      native.tap();
      return;
    } catch {
      // fall through to Capacitor
    }
  }

  if (!pluginReady) return;
  const duration = kind === 'heavy' ? 55 : kind === 'medium' ? 45 : 35;
  void Haptics.vibrate({ duration }).catch(() => {
    const style =
      kind === 'heavy'
        ? ImpactStyle.Heavy
        : kind === 'medium'
          ? ImpactStyle.Medium
          : ImpactStyle.Light;
    void Haptics.impact({ style }).catch(() => {
      /* no vibrator */
    });
  });
}

function onPointerDown(ev: PointerEvent): void {
  if (ev.button > 0) return;
  const target = findHapticTarget(ev.target);
  if (!target) return;
  haptic(kindFor(target));
}

export async function initButtonHaptics(): Promise<void> {
  if (started) return;
  if (typeof window === 'undefined' || !isNativeShell()) return;
  started = true;

  document.addEventListener('pointerdown', onPointerDown, {
    capture: true,
    passive: true,
  });

  pluginReady = true;
}
