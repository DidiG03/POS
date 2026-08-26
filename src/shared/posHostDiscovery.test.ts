import { describe, expect, it } from 'vitest';
import {
  hostFromDebugBody,
  hostsInSlash24,
  isPosDebugBody,
  isPrivateIpv4,
  mergeDiscoveredPosHosts,
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
      restaurantName: 'Code Orbit Agroturizem',
    });
    expect(hit?.name).toBe('Code Orbit Agroturizem');
    expect(hit?.host).toBe('192.168.1.10');
  });
});

describe('mergeDiscoveredPosHosts', () => {
  it('dedupes the same IP found by mDNS and HTTP', () => {
    const merged = mergeDiscoveredPosHosts([
      {
        name: 'Code Orbit POS @ till',
        host: '192.168.1.10',
        httpPort: 3333,
        source: 'mdns',
      },
      {
        name: 'Code Orbit Agroturizem',
        host: '192.168.1.10',
        httpPort: 3333,
        restaurantName: 'Code Orbit Agroturizem',
        source: 'http',
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].restaurantName).toBe('Code Orbit Agroturizem');
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

describe('isPrivateIpv4', () => {
  it('accepts restaurant LAN ranges', () => {
    expect(isPrivateIpv4('192.168.1.10')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
  });
});
