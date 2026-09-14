import { describe, expect, it } from 'vitest';
import { clockCapturePreference, isClockCaptureEnabled } from './clockCapture';

describe('clockCapturePreference', () => {
  it('does not invent ON from an empty cache blob', () => {
    expect(clockCapturePreference(undefined)).toBe(null);
    expect(clockCapturePreference(null)).toBe(null);
    expect(clockCapturePreference({})).toBe(null);
    expect(clockCapturePreference({ preferences: {} })).toBe(null);
  });

  it('reads the explicit admin flag', () => {
    expect(
      clockCapturePreference({ preferences: { captureClockInOut: false } }),
    ).toBe(false);
    expect(
      clockCapturePreference({ preferences: { captureClockInOut: true } }),
    ).toBe(true);
  });
});

describe('isClockCaptureEnabled', () => {
  it('stays on when the preference is missing (current waiter flow)', () => {
    expect(isClockCaptureEnabled(undefined)).toBe(true);
    expect(isClockCaptureEnabled({})).toBe(true);
    expect(isClockCaptureEnabled({ preferences: {} })).toBe(true);
  });

  it('turns off only when the venue disables it', () => {
    expect(
      isClockCaptureEnabled({ preferences: { captureClockInOut: false } }),
    ).toBe(false);
    expect(
      isClockCaptureEnabled({ preferences: { captureClockInOut: true } }),
    ).toBe(true);
  });
});
