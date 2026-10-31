import { describe, expect, it } from 'vitest';
import {
  isKdsDevicePath,
  kdsPairingRequiredOn401,
  kdsShouldShowPairing,
} from './kdsPairing';
import { shouldForceLogoutOn401 } from './lanAuthToken';

describe('an unpaired kitchen display (QA round 6, #2)', () => {
  it('a 401 on a kitchen route in the KDS app asks it to pair', () => {
    expect(kdsPairingRequiredOn401(401, '/kds/tickets?station=BAR', true)).toBe(
      true,
    );
    expect(kdsPairingRequiredOn401(401, '/kds/enabled-stations', true)).toBe(
      true,
    );
  });

  it('only in the KDS app, only for 401, only on kitchen routes', () => {
    // A kitchen phone signed in as staff: a 401 is an expired session.
    expect(kdsPairingRequiredOn401(401, '/kds/tickets', false)).toBe(false);
    expect(kdsPairingRequiredOn401(403, '/kds/tickets', true)).toBe(false);
    expect(kdsPairingRequiredOn401(401, '/settings', true)).toBe(false);
    // The reachability probe is open; it never asks for pairing.
    expect(isKdsDevicePath('/kds/debug')).toBe(false);
  });

  it('a KDS with no device token and no session shows pairing before any request', () => {
    expect(
      kdsShouldShowPairing({
        kdsApp: true,
        hasDeviceToken: false,
        hasSession: false,
      }),
    ).toBe(true);
    expect(
      kdsShouldShowPairing({
        kdsApp: true,
        hasDeviceToken: true,
        hasSession: false,
      }),
    ).toBe(false);
    // The till's own kitchen window (not the KDS app) never pairs.
    expect(
      kdsShouldShowPairing({
        kdsApp: false,
        hasDeviceToken: false,
        hasSession: false,
      }),
    ).toBe(false);
  });

  it('the 401 that used to sign the display out to Select Staff is the same 401', () => {
    // Without the KDS check first, this 401 forces a logout to `#/`.
    expect(
      shouldForceLogoutOn401(401, null, null, undefined, '/kds/tickets'),
    ).toBe(true);
  });
});

describe('KDS pairing wiring', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const root = path.resolve(__dirname, '../../..');
  const read = (rel: string) =>
    fs.readFileSync(path.join(root, rel), 'utf8') as string;

  it('the LAN client asks for pairing before it would force a logout', () => {
    const src = read('src/renderer/browserLanApi.ts');
    const fn = src.slice(src.indexOf('function maybeForceLogout('));
    const pairAt = fn.indexOf('kdsPairingRequiredOn401(');
    const logoutAt = fn.indexOf('shouldForceLogoutOn401(');
    expect(pairAt).toBeGreaterThan(-1);
    expect(pairAt).toBeLessThan(logoutAt);
    expect(fn.slice(pairAt, logoutAt)).toContain('return;');
  });

  it('the KDS app never routes to the waiter Select Staff screen', () => {
    const routes = read('src/renderer/routes.tsx');
    const root = routes.slice(routes.indexOf("path: '/',"));
    expect(root.slice(0, 300)).toContain('isKdsApp()');
    expect(root.slice(0, 300)).toContain('<Navigate to="/kds" replace />');
    const boot = read('src/renderer/app/BootRoot.tsx');
    expect(boot).toMatch(/__KDS_APP__\s*\?\s*'#\/kds'/);
  });
});
