import { describe, expect, it } from 'vitest';
import {
  hostnameFromHostHeader,
  lanHostHeaderAllowed,
  parseAllowedHostsEnv,
} from './lanHostHeader';

describe('hostnameFromHostHeader', () => {
  it('drops the port, brackets and case', () => {
    expect(hostnameFromHostHeader('192.168.1.20:3333')).toBe('192.168.1.20');
    expect(hostnameFromHostHeader('[::1]:3333')).toBe('::1');
    expect(hostnameFromHostHeader('::1')).toBe('::1');
    expect(hostnameFromHostHeader('Till.Local.:3443')).toBe('till.local');
    expect(hostnameFromHostHeader(undefined)).toBe('');
  });
});

describe('lanHostHeaderAllowed', () => {
  it('answers the addresses OneTap apps use', () => {
    for (const host of [
      '127.0.0.1:3333',
      'localhost:3333',
      '192.168.1.20:3333',
      '10.0.0.5',
      '[::1]:3333',
      '[fe80::1c2a:3bff:fe4d:5e6f]:3443',
      'till-mac.local:3333',
      'pos.lan:3333',
      'kasa:3333',
      'DESKTOP-AB12CD:3333',
    ]) {
      expect(lanHostHeaderAllowed(host), host).toBe(true);
    }
  });

  it('refuses a public domain name, whatever it resolves to', () => {
    for (const host of [
      'evil.example.com:3333',
      'rebind.attacker.net',
      '127.0.0.1.attacker.net:3333',
      'localhost.attacker.net',
      'till.local.attacker.net',
    ]) {
      expect(lanHostHeaderAllowed(host), host).toBe(false);
    }
  });

  it('refuses a malformed header but lets a missing one through', () => {
    expect(lanHostHeaderAllowed('exa mple')).toBe(false);
    expect(lanHostHeaderAllowed('[::1')).toBe(false);
    expect(lanHostHeaderAllowed(undefined)).toBe(true);
    expect(lanHostHeaderAllowed('')).toBe(true);
  });

  it("answers this computer's own name and names the owner listed", () => {
    expect(
      lanHostHeaderAllowed('till.corp.example.com:3333', {
        ownHostnames: ['Till.corp.example.com'],
      }),
    ).toBe(true);
    expect(
      lanHostHeaderAllowed('pos.example.com', {
        extra: parseAllowedHostsEnv(' pos.example.com , other.example.com '),
      }),
    ).toBe(true);
    expect(
      lanHostHeaderAllowed('pos.example.com', { ownHostnames: ['till'] }),
    ).toBe(false);
  });
});
