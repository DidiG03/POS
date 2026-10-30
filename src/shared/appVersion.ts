/**
 * Which phone and tablet app versions this till still serves.
 *
 * Phones send their version on every request (`APP_VERSION_HEADER`). One
 * older than `MIN_WAITER_APP_VERSION` is told to update instead of half
 * working. Builds before 0.2.98 printed kitchen slips without a Send key,
 * so the till cannot tell which order a slip belongs to and refuses it
 * (`orderSlip.ts`). Those builds send no version at all; the slip refusal
 * carries the same "update the app" answer.
 */
import { version } from '../../package.json';

export const APP_VERSION: string = version;

export const MIN_WAITER_APP_VERSION = '0.2.98';

export const APP_VERSION_HEADER = 'X-POS-App-Version';

export const APP_UPDATE_REQUIRED = 'APP_UPDATE_REQUIRED';

export function appUpdateRequiredMessage(
  min: string = MIN_WAITER_APP_VERSION,
): string {
  return `This version of the OneTap app is too old for this till. Update the app (version ${min} or newer) and sign in again.`;
}

/** `[major, minor, patch]`, or null when `v` is not a version. */
function parts(v: unknown): number[] | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareAppVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/**
 * True when a client that says it runs `reported` must update. A missing or
 * unreadable version is not judged here (builds before the header).
 */
export function appVersionTooOld(
  reported: unknown,
  min: string = MIN_WAITER_APP_VERSION,
): boolean {
  if (!parts(reported)) return false;
  return compareAppVersions(String(reported), min) < 0;
}
