/**
 * Sign-in and unsent order that survive Android killing the Waiter app.
 *
 * Both live in the WebView's localStorage, which Android writes lazily: an
 * app killed in the background could come back with the PIN screen and an
 * empty cart. On the phone the same keys are also copied to native
 * Preferences (SharedPreferences) whenever the app goes to the background,
 * and copied back at launch when that copy is newer. The session itself
 * still expires after its 12 hours (`session.ts`).
 */

const DURABLE_KEYS = [
  'pos-session',
  'pos-ticket',
  'pos_api_token',
  'pos_pairing_code',
  'pos_lan_device_token',
  'pos_backend_host',
  'pos_backend_http',
  'pos_backend_https',
] as const;
const STAMP_KEY = 'pos_durable_at';

function isNative(): boolean {
  try {
    return Boolean((window as any)?.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

/** Pure core: which keys to copy back into localStorage at launch. */
export function keysToRestore(input: {
  local: Record<string, string | null>;
  localStamp: number;
  saved: Record<string, string | null>;
  savedStamp: number;
}): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(input.saved)) {
    if (value == null) continue;
    const local = input.local[key];
    if (local == null || input.savedStamp > input.localStamp) out.push(key);
  }
  return out;
}

async function flush(): Promise<void> {
  const { Preferences } = await import('@capacitor/preferences');
  const at = String(Date.now());
  for (const key of DURABLE_KEYS) {
    let value: string | null = null;
    try {
      value = localStorage.getItem(key);
    } catch {
      value = null;
    }
    if (value == null) await Preferences.remove({ key });
    else await Preferences.set({ key, value });
  }
  await Preferences.set({ key: STAMP_KEY, value: at });
  try {
    localStorage.setItem(STAMP_KEY, at);
  } catch {
    // ignore
  }
}

/**
 * Copy the native copy back when it is newer, then re-read the stores that
 * already hydrated from localStorage. Call before the first render.
 */
export async function restoreDurableNativeState(): Promise<void> {
  if (!isNative()) return;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const saved: Record<string, string | null> = {};
    const local: Record<string, string | null> = {};
    for (const key of DURABLE_KEYS) {
      saved[key] = (await Preferences.get({ key })).value;
      try {
        local[key] = localStorage.getItem(key);
      } catch {
        local[key] = null;
      }
    }
    const savedStamp = Number(
      (await Preferences.get({ key: STAMP_KEY })).value,
    );
    let localStamp = 0;
    try {
      localStamp = Number(localStorage.getItem(STAMP_KEY)) || 0;
    } catch {
      localStamp = 0;
    }
    const restore = keysToRestore({
      local,
      localStamp,
      saved,
      savedStamp: Number.isFinite(savedStamp) ? savedStamp : 0,
    });
    if (!restore.length) return;
    for (const key of restore) {
      try {
        localStorage.setItem(key, String(saved[key]));
      } catch {
        // ignore
      }
    }
    const [{ useSessionStore }, { useTicketStore }] = await Promise.all([
      import('../stores/session'),
      import('../stores/ticket'),
    ]);
    await useSessionStore.persist?.rehydrate?.();
    await useTicketStore.persist?.rehydrate?.();
  } catch (e) {
    console.warn('[durable] restore failed', e);
  }
}

/** Copy to native storage every time the app leaves the foreground. */
export async function installDurableNativeState(): Promise<void> {
  if (!isNative()) return;
  const save = () => void flush().catch(() => undefined);
  try {
    const { App } = await import('@capacitor/app');
    await App.addListener('pause', save);
    await App.addListener('appStateChange', (s) => {
      if (!s.isActive) save();
    });
  } catch {
    // app plugin missing: fall back to page visibility
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
}
