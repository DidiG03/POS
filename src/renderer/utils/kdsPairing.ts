/**
 * Pairing of the standalone kitchen display (OneTap KDS) with a till.
 *
 * A kitchen display has no staff sign-in: it pairs once with the till's
 * pairing code and keeps a device token (`/kds/pair`). An unpaired display
 * used to send its first `/kds/*` request without one, get 401, and take
 * that for an expired staff session: the app signed "out" to the waiter
 * Select Staff screen, where a kitchen display can do nothing. A 401 on a
 * kitchen route in the KDS app now means "pair this display".
 */

export const KDS_DEVICE_TOKEN_KEY = 'pos.kdsDeviceToken';

/** Fired when the till refuses this display's kitchen requests (401). */
export const KDS_PAIRING_REQUIRED_EVENT = 'pos:kdsPairingRequired';

export function isKdsApp(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__KDS_APP__);
}

type KdsTokenStore = {
  getDeviceTokenSync?: () => string | null;
  saveDeviceToken?: (token: string | null) => Promise<boolean>;
};
const appStore = (): KdsTokenStore | null =>
  typeof window !== 'undefined' ? ((window as any).kdsApp ?? null) : null;

/**
 * The display's pairing token. The KDS app keeps it on disk as well
 * (QA v0.2.104, #13): localStorage alone lost it across an auto-update.
 * Read from either; the file wins when the page lost its copy.
 */
export function readKdsDeviceToken(): string | null {
  let local: string | null = null;
  try {
    local = localStorage.getItem(KDS_DEVICE_TOKEN_KEY) || null;
  } catch {
    local = null;
  }
  if (local) return local;
  const saved = appStore()?.getDeviceTokenSync?.() ?? null;
  if (saved) {
    try {
      localStorage.setItem(KDS_DEVICE_TOKEN_KEY, saved);
    } catch {
      // the file still has it
    }
  }
  return saved;
}

export function writeKdsDeviceToken(token: string): void {
  try {
    localStorage.setItem(KDS_DEVICE_TOKEN_KEY, token);
  } catch {
    // the file below still has it
  }
  void appStore()
    ?.saveDeviceToken?.(token)
    ?.catch(() => undefined);
}

export function clearKdsDeviceToken(): void {
  try {
    localStorage.removeItem(KDS_DEVICE_TOKEN_KEY);
  } catch {
    // ignore
  }
  void appStore()
    ?.saveDeviceToken?.(null)
    ?.catch(() => undefined);
}

/** A kitchen route (`/kds/...`), except the open reachability probe. */
export function isKdsDevicePath(path?: string | null): boolean {
  const pathname = String(path || '').split('?')[0];
  return pathname.startsWith('/kds/') && pathname !== '/kds/debug';
}

/** A 401 that means "pair this display", not "your session expired". */
export function kdsPairingRequiredOn401(
  status: number,
  path: string | null | undefined,
  kdsApp: boolean,
): boolean {
  return status === 401 && kdsApp && isKdsDevicePath(path);
}

/**
 * Show the pairing screen before asking the till for anything: the KDS app
 * with neither a device token nor a staff session cannot be answered.
 */
export function kdsShouldShowPairing(input: {
  kdsApp: boolean;
  hasDeviceToken: boolean;
  hasSession: boolean;
}): boolean {
  return input.kdsApp && !input.hasDeviceToken && !input.hasSession;
}
