export function isClockOnlyRole(role: any): boolean {
  const r = String(role || '').toUpperCase();
  return (
    r === 'KP' ||
    r === 'CHEF' ||
    r === 'HEAD_CHEF' ||
    r === 'FOOD_RUNNER' ||
    r === 'HOST' ||
    r === 'BUSSER' ||
    r === 'BARTENDER' ||
    r === 'BARBACK' ||
    r === 'CLEANER'
  );
}

