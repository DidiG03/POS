// Tablet (Capacitor) haptic feedback. No-ops in Electron and the browser.
//
// Android WebView often labels finger presses as pointerType "mouse", and
// Capacitor's Haptics.impact() waveforms are ignored on several Samsung
// tablets. We therefore:
//   1. Treat every primary press as a tap (no mouse filter).
//   2. Prefer the synchronous PosNativeHaptics Java bridge on Android.
//   3. Fall back to Haptics.vibrate() / Haptics.impact() for iOS.

import { Haptics, ImpactStyle } from '@capacitor/haptics';

type ImpactKind = 'light' | 'medium' | 'heavy';

const HAPTIC_SELECTOR = [
  'button',
  '[role="button"]',
  'a[href]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'select',
  'summary',
  '[data-haptic]',
].join(',');

const MIN_GAP_MS = 40;

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
  const el = start.closest(HAPTIC_SELECTOR);
  if (!el) return null;
  if (el.getAttribute('data-haptic') === 'off') return null;
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

function kindFor(el: Element): ImpactKind {
  const raw = (el.getAttribute('data-haptic') || 'light').toLowerCase();
  if (raw === 'medium' || raw === 'heavy') return raw;
  return 'light';
}

function fireTap(kind: ImpactKind): void {
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
  fireTap(kindFor(target));
}

function onTouchStart(ev: TouchEvent): void {
  const target = findHapticTarget(ev.target);
  if (!target) return;
  fireTap(kindFor(target));
}

export async function initButtonHaptics(): Promise<void> {
  if (started) return;
  if (typeof window === 'undefined' || !isNativeShell()) return;
  started = true;

  document.addEventListener('pointerdown', onPointerDown, {
    capture: true,
    passive: true,
  });
  document.addEventListener('touchstart', onTouchStart, {
    capture: true,
    passive: true,
  });

  pluginReady = true;
}
