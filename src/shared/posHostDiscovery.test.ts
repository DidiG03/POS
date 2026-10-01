import { describe, expect, it } from 'vitest';
import {
  collectLanScanHosts,
  dropLoopbackIfLanSelfPresent,
  hostFromDebugBody,
  hostsInSlash24,
  isPosDebugBody,
  isPrivateIpv4,
  mergeDiscoveredPosHosts,
  parseTypedPosHost,
} from './posHostDiscovery';

describe('hostsInSlash24', () => {
  it('walks the /24 and skips this device', () => {
    const hosts = hostsInSlash24('192.168.1.50');
    expect(hosts).toHaveLength(253);
    expect(hosts).toContain('192.168.1.1');
    expect(hosts).not.toContain('192.168.1.50');
    expect(hosts).not.toContain('192.168.1.0');
    expect(hosts).not.toContain('192.168.1.255');
  });
});

describe('isPosDebugBody', () => {
  it('accepts the POS debug payload', () => {
    expect(isPosDebugBody({ app: 'code-orbit-pos', schemaReady: true })).toBe(
      true,
    );
    expect(isPosDebugBody({ schemaReady: false })).toBe(true);
    expect(isPosDebugBody({ ok: true })).toBe(false);
    expect(isPosDebugBody(null)).toBe(false);
  });
});

describe('hostFromDebugBody', () => {
  it('uses the restaurant name as the label', () => {
    const hit = hostFromDebugBody('192.168.1.10', 3333, {
      app: 'code-orbit-pos',
      schemaReady: true,
      restaurantName: 'OneTap',
    });
    expect(hit?.name).toBe('OneTap');
    expect(hit?.host).toBe('192.168.1.10');
  });
});

describe('mergeDiscoveredPosHosts', () => {
  it('dedupes the same IP found by mDNS and HTTP', () => {
    const merged = mergeDiscoveredPosHosts([
      {
        name: 'OneTap @ till',
        host: '192.168.1.10',
        httpPort: 3333,
        source: 'mdns',
      },
      {
        name: 'OneTap',
        host: '192.168.1.10',
        httpPort: 3333,
        restaurantName: 'OneTap',
        source: 'http',
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].restaurantName).toBe('OneTap');
  });

  it('keeps two different tills as separate choices', () => {
    const merged = mergeDiscoveredPosHosts([
      { name: 'Hall', host: '192.168.1.10', httpPort: 3333 },
      { name: 'Bar', host: '192.168.1.20', httpPort: 3333 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((h) => h.host)).toEqual(['192.168.1.10', '192.168.1.20']);
  });
});

describe('dropLoopbackIfLanSelfPresent', () => {
  it('drops loopback when this machine is already listed on LAN', () => {
    const dropped = dropLoopbackIfLanSelfPresent(
      [
        { name: 'Ullishtja', host: '127.0.0.1', httpPort: 3333 },
        { name: 'Ullishtja', host: '192.168.33.7', httpPort: 3333 },
      ],
      ['192.168.33.7'],
    );
    expect(dropped.map((h) => h.host)).toEqual(['192.168.33.7']);
  });
});

describe('isPrivateIpv4', () => {
  it('accepts restaurant LAN ranges', () => {
    expect(isPrivateIpv4('192.168.1.10')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
  });
});

describe('collectLanScanHosts', () => {
  it('scans the typed POS subnet when the phone has no local IP', () => {
    const hosts = collectLanScanHosts([], ['192.168.33.7']);
    expect(hosts).toContain('192.168.33.7');
    expect(hosts).toContain('192.168.33.1');
    expect(hosts).not.toContain('192.168.1.1');
  });

  it('scans common restaurant subnets when the phone has no local IP', () => {
    const hosts = collectLanScanHosts([]);
    expect(hosts).toContain('192.168.1.1');
    expect(hosts).toContain('192.168.10.16');
    expect(hosts).toContain('10.0.0.1');
  });
});

describe('parseTypedPosHost', () => {
  it('turns a decimal-comma keypad address into dots', () => {
    expect(parseTypedPosHost('192,168,33,250')).toEqual({
      host: '192.168.33.250',
      port: null,
    });
  });

  it('accepts spaces, http:// and a port', () => {
    expect(parseTypedPosHost(' http://192.168.33.250:3333/ ')).toEqual({
      host: '192.168.33.250',
      port: 3333,
    });
    expect(parseTypedPosHost('192, 168, 33, 250')).toEqual({
      host: '192.168.33.250',
      port: null,
    });
  });

  it('rejects public, partial and out-of-range addresses', () => {
    expect(parseTypedPosHost('8.8.8.8')).toBeNull();
    expect(parseTypedPosHost('192.168.33')).toBeNull();
    expect(parseTypedPosHost('192.168.33.250:70000')).toBeNull();
    expect(parseTypedPosHost('')).toBeNull();
  });
});
