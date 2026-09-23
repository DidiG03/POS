import { describe, expect, it } from 'vitest';
import {
  isVatEnabledFromSettings,
  resolveVatEnabledFromMeta,
} from './vatFromFiscal';

describe('vatFromFiscal', () => {
  it('reads fiscal.enabled', () => {
    expect(isVatEnabledFromSettings({ fiscal: { enabled: true } })).toBe(true);
    expect(isVatEnabledFromSettings({ fiscal: { enabled: false } })).toBe(
      false,
    );
    expect(isVatEnabledFromSettings({})).toBe(false);
    expect(isVatEnabledFromSettings(null)).toBe(false);
  });

  it('ignores meta.vatEnabled — fiscal setting always wins', () => {
    expect(
      resolveVatEnabledFromMeta(
        { vatEnabled: true },
        { fiscal: { enabled: false } },
      ),
    ).toBe(false);
    expect(
      resolveVatEnabledFromMeta(
        { vatEnabled: false },
        { fiscal: { enabled: true } },
      ),
    ).toBe(true);
  });

  it('falls back to fiscal when meta omits vatEnabled', () => {
    expect(resolveVatEnabledFromMeta({}, { fiscal: { enabled: true } })).toBe(
      true,
    );
    expect(resolveVatEnabledFromMeta({}, { fiscal: { enabled: false } })).toBe(
      false,
    );
  });
});
