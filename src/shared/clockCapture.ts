/** Explicit flag, or null when the blob is not a real settings document. */
export function clockCapturePreference(settings: unknown): boolean | null {
  if (settings == null || typeof settings !== 'object') return null;
  const raw = (settings as { preferences?: { captureClockInOut?: unknown } })
    ?.preferences?.captureClockInOut;
  if (raw === false) return false;
  if (raw === true) return true;
  return null;
}

/** Host capture stays on unless the venue turned it off. */
export function isClockCaptureEnabled(settings: unknown): boolean {
  return clockCapturePreference(settings) !== false;
}
