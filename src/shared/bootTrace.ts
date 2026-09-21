/**
 * Boot / cold-start timing breadcrumbs. Kept as no-ops in production builds
 * so call sites stay cheap to leave in place without console noise.
 */
const startedAt =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function nowMs(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function bootTrace(_step: string, _extra?: string | number): void {
  void startedAt;
  void nowMs;
}

export async function bootStep<T>(
  _name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await fn();
}
