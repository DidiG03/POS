import { describe, expect, it, beforeEach } from 'vitest';
import { useLicenseCapabilities } from '../stores/licenseCapabilities';
import { hydrateLicenseEditionFromSettings } from './hydrateLicenseEdition';

describe('hydrateLicenseEditionFromSettings', () => {
  beforeEach(() => {
    useLicenseCapabilities.setState({
      edition: undefined,
      hydrated: false,
      hasReservations: true,
      hasTables: true,
      hasKds: true,
    });
  });

  it('applies a store till so admin gets barcode and inventory', () => {
    hydrateLicenseEditionFromSettings({ licenseEdition: 'STORE' });
    const s = useLicenseCapabilities.getState();
    expect(s.hydrated).toBe(true);
    expect(s.edition).toBe('STORE');
    expect(s.hasTables).toBe(false);
  });

  it('marks restaurant as hydrated when the till sends no edition', () => {
    hydrateLicenseEditionFromSettings({ licenseEdition: null });
    const s = useLicenseCapabilities.getState();
    expect(s.hydrated).toBe(true);
    expect(s.hasTables).toBe(true);
  });

  it('ignores a failed settings payload', () => {
    hydrateLicenseEditionFromSettings(null);
    expect(useLicenseCapabilities.getState().hydrated).toBe(false);
  });
});
