import { describe, expect, it } from 'vitest';
import {
  allowLanCorsOrigin,
  isElectronCompanionOrigin,
  isTrustedLanClient,
} from './lanCors';

function req(header?: string) {
  return {
    headers: header ? { 'x-pos-client': header } : {},
  } as any;
}

describe('allowLanCorsOrigin', () => {
  it('allows the Admin Vite origin even when POS is a packaged till', () => {
    expect(
      allowLanCorsOrigin('http://localhost:5173', '192.168.33.250:3333'),
    ).toBe('http://localhost:5173');
    expect(allowLanCorsOrigin('http://127.0.0.1:5173', '127.0.0.1:3333')).toBe(
      'http://127.0.0.1:5173',
    );
  });

  it('allows packaged Electron file origins', () => {
    expect(allowLanCorsOrigin('null', '192.168.33.250:3333')).toBe('null');
    expect(allowLanCorsOrigin('file://', '192.168.33.250:3333')).toBe(
      'file://',
    );
  });

  it('rejects a random website', () => {
    expect(
      allowLanCorsOrigin('https://evil.example', '192.168.33.250:3333'),
    ).toBe(null);
  });
});

describe('isTrustedLanClient', () => {
  it('lets Admin and KDS through the web-access toggle from Electron', () => {
    expect(
      isTrustedLanClient(req('admin'), undefined, 'http://localhost:5173'),
    ).toBe(true);
    expect(isTrustedLanClient(req('kds'), undefined, 'null')).toBe(true);
    expect(
      isTrustedLanClient(req('admin'), undefined, 'https://evil.example'),
    ).toBe(false);
  });

  it('still treats the Capacitor native marker as trusted', () => {
    expect(isTrustedLanClient(req('native'))).toBe(true);
    expect(isElectronCompanionOrigin('http://localhost:5173')).toBe(true);
  });
});
