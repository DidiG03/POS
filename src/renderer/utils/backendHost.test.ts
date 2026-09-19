import { describe, expect, it } from 'vitest';
import { adminMobileLaunchHash } from './adminMobileBoot';
import {
  companionPersistLocationHash,
  pickStoredBackendHost,
} from './backendHost';

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

describe('pickStoredBackendHost', () => {
  it('prefers a saved till, then the build-time default', () => {
    expect(
      pickStoredBackendHost({
        storedHost: ' 10.0.0.5 ',
        envHost: '192.168.1.1',
        isMobileShell: true,
        locationHostname: 'localhost',
      }),
    ).toBe('10.0.0.5');
    expect(
      pickStoredBackendHost({
        storedHost: null,
        envHost: '192.168.1.1',
        isMobileShell: true,
        locationHostname: 'localhost',
      }),
    ).toBe('192.168.1.1');
  });

  it('does not fall through to localhost on a fresh mobile install', () => {
    expect(
      pickStoredBackendHost({
        storedHost: null,
        envHost: '',
        isMobileShell: true,
        locationHostname: 'localhost',
      }),
    ).toBe('');
    expect(
      pickStoredBackendHost({
        storedHost: '   ',
        envHost: '',
        isMobileShell: true,
        locationHostname: 'localhost',
      }),
    ).toBe('');
  });

  it('uses the page hostname, then localhost, off the mobile shell', () => {
    expect(
      pickStoredBackendHost({
        storedHost: null,
        envHost: '',
        isMobileShell: false,
        locationHostname: 'till.local',
      }),
    ).toBe('till.local');
    expect(
      pickStoredBackendHost({
        storedHost: null,
        envHost: '',
        isMobileShell: false,
        locationHostname: '',
      }),
    ).toBe('localhost');
  });

  it('opens Admin setup when the phone has no saved till', () => {
    const host = pickStoredBackendHost({
      storedHost: null,
      envHost: '',
      isMobileShell: true,
      locationHostname: 'localhost',
    });
    expect(adminMobileLaunchHash('', host)).toBe('#/admin-setup');
    expect(adminMobileLaunchHash('', '10.0.0.5')).toBe('#/admin');
  });
});
