/**
 * Staff PIN rules shared by the admin forms, the login screen and the host.
 *
 * Staff (waiter, cashier, bartender…) may use 1–6 letters or digits so a
 * single tap/character is enough on a busy floor. Admins keep 4–6 digits:
 * an admin PIN also approves discounts, voids and refunds, so a
 * one-character admin PIN could be guessed by anyone at the till.
 *
 * Letters are case-insensitive: PINs are lower-cased before hashing and
 * before comparing, so "A" and "a" are the same PIN. Existing digit PINs
 * are unaffected.
 */

export const STAFF_PIN_MAX_LENGTH = 6;
export const ADMIN_PIN_MIN_LENGTH = 4;

const STAFF_PIN_RE = /^[0-9a-z]{1,6}$/;
const ADMIN_PIN_RE = /^\d{4,6}$/;

export type StaffPinError = 'required' | 'adminDigits' | 'staffFormat';

export function isAdminPinRole(role: unknown): boolean {
  return String(role || '').toUpperCase() === 'ADMIN';
}

/** Canonical form used for hashing and comparing. */
export function normalizePin(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase();
}

/** Strip characters the role can't use while the user is typing. */
export function sanitizePinInput(raw: string, role?: unknown): string {
  const allowed = isAdminPinRole(role) ? /[^0-9]/g : /[^0-9A-Za-z]/g;
  return String(raw || '')
    .replace(allowed, '')
    .slice(0, STAFF_PIN_MAX_LENGTH);
}

/**
 * Promoting staff to ADMIN keeps their old (possibly one-character) PIN
 * unless a new one is set, so promotion requires a fresh admin PIN.
 */
export function promotionNeedsNewPin(opts: {
  currentRole: unknown;
  nextRole: unknown;
  pin: unknown;
}): boolean {
  if (normalizePin(opts.pin)) return false;
  return (
    !isAdminPinRole(opts.currentRole) &&
    opts.nextRole != null &&
    isAdminPinRole(opts.nextRole)
  );
}

/**
 * Format check. Pass `role` when creating/updating a user; omit it at login
 * (the stored hash decides, and admin hashes are always 4–6 digits).
 */
export function staffPinError(
  pin: unknown,
  role?: unknown,
): StaffPinError | null {
  const p = normalizePin(pin);
  if (!p) return 'required';
  if (isAdminPinRole(role)) return ADMIN_PIN_RE.test(p) ? null : 'adminDigits';
  return STAFF_PIN_RE.test(p) ? null : 'staffFormat';
}
