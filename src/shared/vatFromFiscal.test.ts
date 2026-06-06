import { describe, expect, it } from 'vitest';
import {
  isVatEnabledFromSettings,
  resolveVatEnabledFromMeta,
} from './vatFromFiscal';

describe('vatFromFiscal', () => {
  it('enables VAT only when fiscalization is on', () => {
    expect(isVatEnabledFromSettings({ fiscal: { enabled: true } })).toBe(true);
    expect(isVatEnabledFromSettings({ fiscal: { enabled: false } })).toBe(
      false,
    );
    expect(isVatEnabledFromSettings({})).toBe(false);
    expect(isVatEnabledFromSettings(null)).toBe(false);
  });

  it('uses meta.vatEnabled when present on payment payloads', () => {
    expect(
      resolveVatEnabledFromMeta(
        { vatEnabled: true },
        { fiscal: { enabled: false } },
      ),
    ).toBe(true);
    expect(
      resolveVatEnabledFromMeta(
        { vatEnabled: false },
        { fiscal: { enabled: true } },
      ),
    ).toBe(false);
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
