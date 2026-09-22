import { isClockCaptureEnabled } from './clockCapture';

export type BlockShiftReopenHours = 2 | 4 | 8 | 12 | 24;

export type BlockShiftReopenPref = {
  enabled?: boolean;
  /** Hours after last closedAt before another clock-in is allowed. */
  hours?: number;
};

export function blockShiftReopenPref(
  settings: unknown,
): BlockShiftReopenPref | null {
  if (settings == null || typeof settings !== 'object') return null;
  const raw = (settings as { preferences?: { blockShiftReopen?: unknown } })
    ?.preferences?.blockShiftReopen;
  if (raw == null || typeof raw !== 'object') return null;
  return raw as BlockShiftReopenPref;
}

const ALLOWED_HOURS: readonly BlockShiftReopenHours[] = [2, 4, 8, 12, 24];

export function normalizeBlockShiftReopenHours(
  raw: unknown,
): BlockShiftReopenHours {
  const n = Math.round(Number(raw));
  return (ALLOWED_HOURS as readonly number[]).includes(n)
    ? (n as BlockShiftReopenHours)
    : 12;
}

/** True when the venue blocks a second clock-in after clock-out. */
export function isBlockShiftReopenEnabled(settings: unknown): boolean {
  if (!isClockCaptureEnabled(settings)) return false;
  return blockShiftReopenPref(settings)?.enabled === true;
}

export function blockShiftReopenHours(
  settings: unknown,
): BlockShiftReopenHours {
  return normalizeBlockShiftReopenHours(blockShiftReopenPref(settings)?.hours);
}

/**
 * After a waiter clocks out, block another clock-in until `hours` have
 * passed since that closedAt. Capture must be on and the preference enabled.
 */
export function shiftReopenBlockedUntil(
  settings: unknown,
  lastClosedAt: Date | string | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!isBlockShiftReopenEnabled(settings)) return null;
  if (lastClosedAt == null) return null;
  const closed =
    lastClosedAt instanceof Date ? lastClosedAt : new Date(lastClosedAt);
  if (!Number.isFinite(closed.getTime())) return null;
  const hours = blockShiftReopenHours(settings);
  const reopenAt = new Date(closed.getTime() + hours * 60 * 60 * 1000);
  if (now.getTime() >= reopenAt.getTime()) return null;
  return reopenAt;
}

export function isShiftReopenBlocked(
  settings: unknown,
  lastClosedAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  return shiftReopenBlockedUntil(settings, lastClosedAt, now) != null;
}
