/**
 * Idempotency keys for write operations that may be replayed.
 *
 * The offline queue retries a failed write until it lands, which is only safe
 * if the host can recognise a replay of something it already applied. Both the
 * IPC handlers and the LAN routes dedupe on `idempotencyKey` — but only when
 * the client actually sends one, and the key has to be created *before* the
 * first attempt. A key minted during the retry is a key the host has never
 * seen, so it defeats the dedupe and writes the record a second time.
 *
 * One key per user intent: generate it once when the waiter taps the button,
 * then reuse it for every retry of that same tap.
 */

/**
 * A random key for a single user intent.
 *
 * Deliberately random rather than derived from the payload: two identical
 * orders a few minutes apart (another round of the same drinks) are two real
 * orders, and a content-derived key would silently collapse them into one.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c !== 'undefined' && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Older WebViews without randomUUID still need a key; collision risk across
  // one device's queue is negligible at this scale.
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
