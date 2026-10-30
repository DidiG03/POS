/**
 * What the LAN API shows a device that has not signed in.
 *
 * `/auth/users`, `/events/login` and `/settings` answered anyone on the
 * Wi-Fi: the staff list, the fiscal configuration (NUIS, operator codes,
 * the easyPos address) and every printer's address. Now:
 *   - the staff list (and its live updates) needs a signed-in session, a
 *     paired device, or the till itself;
 *   - `/settings` without a session is cut to what the sign-in screen
 *     paints (`bootSettingsForSignIn`); signed-in clients get the full,
 *     redacted settings as before (`settingsPresent.ts`).
 *
 * A device pairs with `/pairing/verify` (the venue's pairing code, or none
 * when the venue does not require one) or by signing in, and gets a device
 * token bound to the current pairing code: changing the code in Admin
 * un-pairs every device. Kitchen displays get theirs from `/kds/pair`.
 */
import crypto from 'node:crypto';

export const PAIRING_REQUIRED = 'PAIRING_REQUIRED';
export const PAIRING_REQUIRED_MESSAGE =
  'Pair this device with the till first (enter the pairing code shown in Admin).';

/** Header (and SSE query parameter `device`) carrying the device token. */
export const DEVICE_TOKEN_HEADER = 'x-pos-device';

/** Pre-login routes that need a paired device, a session, or the till. */
export const PAIRED_DEVICE_PATHS: ReadonlySet<string> = new Set([
  '/auth/users',
  '/events/login',
]);

export type DeviceTokenPurpose = 'kds_device' | 'lan_device';

const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sign(secret: string, body: string): string {
  return base64url(crypto.createHmac('sha256', secret).update(body).digest());
}

/**
 * Fingerprint of the pairing code a token was issued for. `kds:` keeps the
 * fingerprint of tokens issued before the purposes were split.
 */
function pairingFingerprint(secret: string, pairingCode: string): string {
  return sign(secret, `kds:${pairingCode}`).slice(0, 16);
}

export function issueDeviceToken(
  secret: string,
  pairingCode: string,
  purpose: DeviceTokenPurpose,
  now = Date.now(),
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const payload = base64url(
    JSON.stringify({
      purpose,
      pc: pairingFingerprint(secret, pairingCode),
      iat,
      exp: iat + DEVICE_TTL_SECONDS,
    }),
  );
  const body = `${header}.${payload}`;
  return `${body}.${sign(secret, body)}`;
}

/**
 * True when `token` is a device token of one of `purposes`, unexpired, and
 * issued for `pairingCode` (the till's current code).
 */
export function verifyDeviceToken(
  secret: string,
  token: unknown,
  pairingCode: string,
  purposes: readonly DeviceTokenPurpose[],
  now = Date.now(),
): boolean {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !pairingCode) return false;
  const [h, p, s] = parts;
  const expected = sign(secret, `${h}.${p}`);
  if (s.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s))) {
    return false;
  }
  let payload: any;
  try {
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch {
    return false;
  }
  if (!purposes.includes(String(payload?.purpose || '') as DeviceTokenPurpose))
    return false;
  if (typeof payload.exp === 'number' && payload.exp < now / 1000) return false;
  return payload.pc === pairingFingerprint(secret, pairingCode);
}

/**
 * The settings a device that has not signed in may read: what the sign-in
 * screen paints (theme, language, edition, whether to ask for clock-in) and
 * whether to ask for a pairing code. No fiscal configuration, printers,
 * business identity or host details.
 */
export function bootSettingsForSignIn(
  settings: Record<string, any>,
): Record<string, unknown> {
  const prefs = (settings?.preferences || {}) as Record<string, unknown>;
  const security = (settings?.security || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    restaurantName: settings?.restaurantName ?? '',
    currency: settings?.currency,
    preferences: {
      ...(prefs.language !== undefined ? { language: prefs.language } : {}),
      ...(prefs.theme !== undefined ? { theme: prefs.theme } : {}),
      ...(prefs.captureClockInOut !== undefined
        ? { captureClockInOut: prefs.captureClockInOut }
        : {}),
    },
    security: {
      requirePairingCode: Boolean(security.requirePairingCode),
    },
    licenseEdition: settings?.licenseEdition ?? null,
    devEditionSwitch: Boolean(settings?.devEditionSwitch),
    enableAdmin: Boolean(settings?.enableAdmin),
    /** Tells the client this is the pre-sign-in subset, not to be cached. */
    signInOnly: true,
  };
  return out;
}
