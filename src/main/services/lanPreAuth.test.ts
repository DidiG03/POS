import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAIRED_DEVICE_PATHS,
  bootSettingsForSignIn,
  issueDeviceToken,
  verifyDeviceToken,
} from './lanPreAuth';

const secret = 'test-secret';

describe('device pairing token (QA round 5, #4)', () => {
  it('verifies for the pairing code it was issued for', () => {
    const t = issueDeviceToken(secret, '482913', 'lan_device');
    expect(verifyDeviceToken(secret, t, '482913', ['lan_device'])).toBe(true);
  });

  it('changing the pairing code un-pairs the device', () => {
    const t = issueDeviceToken(secret, '482913', 'lan_device');
    expect(verifyDeviceToken(secret, t, '111222', ['lan_device'])).toBe(false);
  });

  it('is refused for another purpose, a forged signature or after expiry', () => {
    const t = issueDeviceToken(secret, '482913', 'lan_device');
    expect(verifyDeviceToken(secret, t, '482913', ['kds_device'])).toBe(false);
    expect(verifyDeviceToken('other', t, '482913', ['lan_device'])).toBe(false);
    const forged = `${t.split('.').slice(0, 2).join('.')}.AAAA`;
    expect(verifyDeviceToken(secret, forged, '482913', ['lan_device'])).toBe(
      false,
    );
    const year = 366 * 24 * 60 * 60 * 1000;
    expect(
      verifyDeviceToken(secret, t, '482913', ['lan_device'], Date.now() + year),
    ).toBe(false);
    expect(verifyDeviceToken(secret, '', '482913', ['lan_device'])).toBe(false);
    expect(verifyDeviceToken(secret, 'a.b.c', '482913', ['lan_device'])).toBe(
      false,
    );
  });

  it('kitchen display tokens issued before this change still verify', () => {
    const t = issueDeviceToken(secret, '482913', 'kds_device');
    expect(
      verifyDeviceToken(secret, t, '482913', ['lan_device', 'kds_device']),
    ).toBe(true);
  });
});

describe('settings before sign-in (QA round 5, #4)', () => {
  const full = {
    restaurantName: 'Bar Q',
    currency: 'ALL',
    businessInfo: { nuis: 'L12345678A', address: 'Rr. X' },
    preferences: {
      language: 'sq',
      theme: 'dark',
      captureClockInOut: false,
      approvals: { requireManagerPinForDiscount: true },
    },
    printers: [{ id: 'p1', ip: '10.0.0.40', port: 9100 }],
    printerRouting: { receiptPrinterId: 'p1' },
    fiscal: {
      enabled: true,
      baseUrl: 'https://demo.easypos.al',
      nuis: 'L12345678A',
      operatorCode: 'ab123cd456',
      authTokenConfigured: true,
    },
    security: {
      requirePairingCode: true,
      pairingCode: '482913',
      allowLan: true,
    },
    host: { openAtLogin: true },
    licenseEdition: 'RESTAURANT',
  };

  it('keeps only what the sign-in screen paints', () => {
    const out: any = bootSettingsForSignIn(full);
    expect(out).toMatchObject({
      restaurantName: 'Bar Q',
      currency: 'ALL',
      preferences: { language: 'sq', theme: 'dark', captureClockInOut: false },
      security: { requirePairingCode: true },
      licenseEdition: 'RESTAURANT',
      signInOnly: true,
    });
    const text = JSON.stringify(out);
    for (const secretish of [
      'fiscal',
      'printers',
      'printerRouting',
      '10.0.0.40',
      'L12345678A',
      'operatorCode',
      'easypos',
      '482913',
      'host',
      'approvals',
    ]) {
      expect(text).not.toContain(secretish);
    }
  });
});

describe('LAN API wiring (QA round 5, #4)', () => {
  const api = fs.readFileSync(path.resolve(__dirname, '../api.ts'), 'utf8');

  it('the staff list and its live updates need a paired device or a session', () => {
    expect([...PAIRED_DEVICE_PATHS].sort()).toEqual([
      '/auth/users',
      '/events/login',
    ]);
    expect(api).toMatch(/PAIRED_DEVICE_PATHS\.has\(pathname\)/);
    expect(api).toContain('code: PAIRING_REQUIRED');
  });

  it('settings without a session are the sign-in subset', () => {
    expect(api).toContain('signedIn ? result : bootSettingsForSignIn(result)');
  });

  it('pairing and sign-in hand out a device token', () => {
    expect(api.match(/issueDeviceToken\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('the staff list never carries a PIN or its hash', () => {
    const at = api.indexOf('// Local-first: always use local DB for users');
    expect(at).toBeGreaterThan(0);
    const handler = api.slice(at, api.indexOf('corsOrigin,', at));
    expect(handler).not.toMatch(/pin/i);
  });
});
