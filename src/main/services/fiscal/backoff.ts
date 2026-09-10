/**
 * Backoff for the fiscal recovery sequence.
 *
 * Exponential with jitter, capped at 30s per the spec. The jitter is not
 * decoration: a till, a tablet and the offline queue can all be recovering
 * the same docId after a network drop, and a fixed schedule marches them
 * into the provider in lockstep — which is how "another request is
 * processing" turns into a loop none of them escape.
 *
 * Equal jitter (half fixed, half random) rather than full jitter, because
 * the first thing after the delay is a status check on a document that may
 * still be being written upstream. Full jitter can return ~0ms, which asks
 * the question before the provider can answer it.
 */

/** The spec's ceiling. No single wait exceeds this, however many attempts. */
export const BACKOFF_CAP_MS = 30_000;

/** First delay. Doubles per attempt from here. */
export const BACKOFF_BASE_MS = 1_000;

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** Injectable for tests. Must return [0, 1). */
  random?: () => number;
}

/**
 * Delay before attempt `attempt` (1-based, so attempt 1 is the first
 * *retry* — there is no delay before the initial request).
 */
export function backoffDelayMs(
  attempt: number,
  options?: BackoffOptions,
): number {
  const base = Math.max(1, options?.baseMs ?? BACKOFF_BASE_MS);
  const cap = Math.max(base, options?.capMs ?? BACKOFF_CAP_MS);
  const random = options?.random ?? Math.random;
  const n = Math.max(1, Math.floor(attempt));
  // 2 ** (n - 1) overflows into Infinity past ~1024 attempts; clamping the
  // exponent keeps the arithmetic finite so the cap still applies.
  const exponent = Math.min(n - 1, 40);
  const ceiling = Math.min(cap, base * 2 ** exponent);
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

/** The full schedule for `attempts` retries. Useful for tests and logs. */
export function backoffSchedule(
  attempts: number,
  options?: BackoffOptions,
): number[] {
  const out: number[] = [];
  for (let i = 1; i <= Math.max(0, Math.floor(attempts)); i++) {
    out.push(backoffDelayMs(i, options));
  }
  return out;
}

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
