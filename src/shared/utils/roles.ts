export const CLOCK_ONLY_ROLES = new Set([
  'KP',
  'CHEF',
  'HEAD_CHEF',
  'FOOD_RUNNER',
  'HOST',
  'BUSSER',
  'BARTENDER',
  'BARBACK',
  'CLEANER',
]);

export function isClockOnlyRole(role: unknown): boolean {
  const r = String(role || '').toUpperCase();
  return CLOCK_ONLY_ROLES.has(r);
}

// Mobile-specific role policy. Admin desktop has its own RequireAdmin
// guard; these helpers describe what a logged-in user should be able
// to access from the Capacitor / browser shell.

// Roles allowed to view the Reports screen on mobile.
export const MOBILE_REPORTS_ROLES = new Set(['ADMIN', 'CASHIER']);

// Roles allowed to view the KDS screen on mobile (kitchen staff).
export const MOBILE_KDS_ROLES = new Set([
  'KP',
  'CHEF',
  'HEAD_CHEF',
  'FOOD_RUNNER',
]);

export function canSeeReportsOnMobile(role: unknown): boolean {
  return MOBILE_REPORTS_ROLES.has(String(role || '').toUpperCase());
}

export function canSeeKdsOnMobile(role: unknown): boolean {
  return MOBILE_KDS_ROLES.has(String(role || '').toUpperCase());
}
