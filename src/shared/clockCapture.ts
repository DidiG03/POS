/** Waiter/staff shift times are captured unless the venue turns it off. */
export function isClockCaptureEnabled(settings: unknown): boolean {
  const raw = (settings as { preferences?: { captureClockInOut?: unknown } })
    ?.preferences?.captureClockInOut;
  return raw !== false;
}
