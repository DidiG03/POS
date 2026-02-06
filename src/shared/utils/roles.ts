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
