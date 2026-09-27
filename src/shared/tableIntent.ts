/**
 * Open/close ordering uses the till's clock only.
 *
 * A phone stores when the waiter tapped, then sends how long ago that was.
 * The till subtracts that age from its own clock. Pay, Send, and transfers
 * already stamp the till clock, so a phone running fast or slow no longer
 * wins or loses because its clock disagrees with the till.
 */
export const MAX_TABLE_INTENT_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Age of a tap, measured on the device that stored the tap time. */
export function ageSinceTap(tappedAt: number, now = Date.now()): number {
  const at = Number(tappedAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  const age = now - at;
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.min(age, MAX_TABLE_INTENT_AGE_MS);
}

/** Till-clock instant of a tap that happened `ageMs` ago. */
export function intentAtFromAge(ageMs: number, now = Date.now()): number {
  const age = Number(ageMs);
  if (!Number.isFinite(age) || age < 0) return now;
  return now - Math.min(age, MAX_TABLE_INTENT_AGE_MS);
}

/**
 * `intentAgeMs` is the current client. `intentAt` above 1e11 is an older
 * client that still sent its own clock; keep that value so a half-upgraded
 * phone can still open a table.
 */
export function resolveHostIntent(
  input: { intentAgeMs?: unknown; intentAt?: unknown },
  now = Date.now(),
): number | undefined {
  if (input.intentAgeMs != null && input.intentAgeMs !== '') {
    const age = Number(input.intentAgeMs);
    if (Number.isFinite(age) && age >= 0) return intentAtFromAge(age, now);
  }
  const legacy = Number(input.intentAt);
  if (Number.isFinite(legacy) && legacy > 1e11) return legacy;
  return undefined;
}
