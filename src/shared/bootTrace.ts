const startedAt = nowMs();

function nowMs(): number {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  ) {
    return performance.now();
  }
  return Date.now();
}

/** Elapsed since this process loaded. Main and renderer each have their own clock. */
export function bootTrace(step: string, extra?: string | number): void {
  const ms = Math.round(nowMs() - startedAt);
  const suffix = extra == null || extra === '' ? '' : ` ${extra}`;
  console.log(`[boot] +${ms}ms ${step}${suffix}`);
}

export async function bootStep<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = nowMs();
  try {
    return await fn();
  } finally {
    console.log(`[boot] ${name} ${Math.round(nowMs() - t0)}ms`);
  }
}
