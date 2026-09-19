import { describe, expect, it } from 'vitest';
import { companionPersistLocationHash } from './backendHost';

describe('companionPersistLocationHash', () => {
  it('lets Electron Admin/KDS reload via saveConfig', () => {
    expect(
      companionPersistLocationHash({
        hasSaveConfig: true,
        adminApp: true,
        kdsApp: false,
      }),
    ).toBeNull();
  });

  it('lands Capacitor Admin on PIN after a till is saved', () => {
    expect(
      companionPersistLocationHash({
        hasSaveConfig: false,
        adminApp: true,
        kdsApp: false,
      }),
    ).toBe('#/admin');
  });

  it('does not move Waiter/tablets', () => {
    expect(
      companionPersistLocationHash({
        hasSaveConfig: false,
        adminApp: false,
        kdsApp: false,
      }),
    ).toBeNull();
  });
});
