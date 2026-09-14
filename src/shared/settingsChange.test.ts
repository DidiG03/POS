import { describe, expect, it } from 'vitest';
import {
  clockCaptureFromChange,
  settingsChangeFromHost,
  themeFromChange,
} from './settingsChange';

describe('settingsChangeFromHost', () => {
  it('sends the live clock and theme flags, not a full settings document', () => {
    expect(
      settingsChangeFromHost({
        currency: 'EUR',
        security: { pairingCode: 'secret' },
        preferences: { theme: 'light', captureClockInOut: false },
      }),
    ).toEqual({ theme: 'light', captureClockInOut: false });
  });

  it('defaults clock on only for a hydrated host document', () => {
    expect(settingsChangeFromHost({ preferences: { theme: 'dark' } })).toEqual({
      theme: 'dark',
      captureClockInOut: true,
    });
  });
});

describe('change payload readers', () => {
  it('ignores empty events so a fiscal save cannot flip clock or theme', () => {
    expect(clockCaptureFromChange(undefined)).toBe(null);
    expect(clockCaptureFromChange({})).toBe(null);
    expect(themeFromChange({})).toBeUndefined();
    expect(clockCaptureFromChange({ captureClockInOut: false })).toBe(false);
  });
});
