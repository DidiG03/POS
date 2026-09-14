export type SettingsChangePayload = {
  theme?: 'light' | 'dark' | null;
  captureClockInOut?: boolean;
};

/** Public slice of host settings that tablets need for chrome. Never a full doc. */
export function settingsChangeFromHost(
  settings: unknown,
): SettingsChangePayload {
  const prefs = (
    settings as {
      preferences?: { theme?: unknown; captureClockInOut?: unknown };
    } | null
  )?.preferences;
  const themeRaw = String(prefs?.theme ?? '')
    .trim()
    .toLowerCase();
  return {
    theme: themeRaw === 'light' || themeRaw === 'dark' ? themeRaw : null,
    captureClockInOut: prefs?.captureClockInOut !== false,
  };
}

export function clockCaptureFromChange(payload: unknown): boolean | null {
  const v = (payload as SettingsChangePayload | null)?.captureClockInOut;
  return typeof v === 'boolean' ? v : null;
}

export function themeFromChange(payload: unknown): unknown {
  return (payload as SettingsChangePayload | null)?.theme;
}
