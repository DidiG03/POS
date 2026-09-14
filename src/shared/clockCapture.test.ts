import { describe, expect, it } from 'vitest';
import { isClockCaptureEnabled } from './clockCapture';

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
