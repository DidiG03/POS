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

/**
 * A PIN being set or changed: 4–6 letters or digits. One character was
 * allowed, and throttling was then the only thing between a guesser and
 * a waiter's account. PINs set before keep working at sign-in
 * (`STAFF_PIN_LOGIN_RE`); admins are told whose to replace.
 */
const STAFF_PIN_RE = /^[0-9a-z]{4,6}$/;
/** Sign-in: what may have been set before the 4-character rule. */
const STAFF_PIN_LOGIN_RE = /^[0-9a-z]{1,6}$/;
export const STAFF_PIN_MIN_LENGTH = 4;
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
  // No role: a sign-in, where a PIN set before the 4-character rule
  // still has to work.
  if (role === undefined || role === null || role === '') {
    return STAFF_PIN_LOGIN_RE.test(p) ? null : 'staffFormat';
  }
  return STAFF_PIN_RE.test(p) ? null : 'staffFormat';
}

/** A PIN that signs in but would not be accepted if set today. */
export function isShortStaffPin(pin: unknown, role: unknown): boolean {
  if (isAdminPinRole(role)) return false;
  const p = normalizePin(pin);
  return p.length > 0 && p.length < STAFF_PIN_MIN_LENGTH;
}

/** Admin PINs the host refuses as too easy to guess. */
export const COMMON_ADMIN_PINS: readonly string[] = [
  '0000',
  '1111',
  '1234',
  '12345',
  '123456',
  '9999',
  '99999',
  '999999',
];

/**
 * True for an admin PIN on the common list. The admin forms check this
 * before submitting, so the rule shows on the form instead of only as a
 * host error after the fact.
 */
export function isCommonAdminPin(pin: unknown): boolean {
  return COMMON_ADMIN_PINS.includes(normalizePin(pin));
}
