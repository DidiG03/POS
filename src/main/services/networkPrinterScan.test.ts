/**
 * Printer discovery is a LAN walk plus a merge of mDNS names onto TCP
 * hits. The interesting cases are the ones that would otherwise scan the
 * wrong machines, or show the same printer twice.
 */

import { describe, expect, it } from 'vitest';
import {
  classify9100Response,
  hostsInSubnet,
  isPrivateIpv4,
  MAX_UNCONFIRMED_TCP,
  resultFrom9100Socket,
  scanNetworkPrinters,
} from './networkPrinterScan';

describe('isPrivateIpv4', () => {
  it('accepts restaurant LAN ranges and rejects everything else', () => {
    expect(isPrivateIpv4('192.168.1.87')).toBe(true);
    expect(isPrivateIpv4('10.0.0.5')).toBe(true);
    expect(isPrivateIpv4('172.16.4.2')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateIpv4('127.0.0.1')).toBe(false);
    expect(isPrivateIpv4('169.254.1.1')).toBe(false);
  });
});

describe('hostsInSubnet', () => {
  it('walks a /24 and skips the host, the network, and broadcast', () => {
    const hosts = hostsInSubnet('192.168.1.50', '255.255.255.0');
    expect(hosts).toHaveLength(253);
    expect(hosts).toContain('192.168.1.87');
    expect(hosts).not.toContain('192.168.1.50');
    expect(hosts).not.toContain('192.168.1.0');
    expect(hosts).not.toContain('192.168.1.255');
    expect(hosts).not.toContain('192.168.2.1');
  });

  it('caps a /16 to the host /24 so a bad mask cannot scan 65k addresses', () => {
    const hosts = hostsInSubnet('10.4.8.9', '255.255.0.0');
    expect(hosts.every((h) => h.startsWith('10.4.8.'))).toBe(true);
    expect(hosts).toHaveLength(253);
  });

  it('honours a tight mask', () => {
    const hosts = hostsInSubnet('192.168.1.10', '255.255.255.248');
    expect(hosts).toEqual([
      '192.168.1.9',
      '192.168.1.11',
      '192.168.1.12',
      '192.168.1.13',
      '192.168.1.14',
    ]);
  });

  it('refuses to enumerate a public address', () => {
    expect(hostsInSubnet('8.8.8.8', '255.255.255.0')).toEqual([]);
  });
});

describe('scanNetworkPrinters', () => {
  it('returns hosts that look like ESC/POS printers on 9100', async () => {
    const printers = new Set(['192.168.1.87', '192.168.1.11']);
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [],
      probe: async (host) => (printers.has(host) ? 'printer' : 'closed'),
    });
    expect(found.map((p) => `${p.ip}:${p.port}`).sort()).toEqual([
      '192.168.1.11:9100',
      '192.168.1.87:9100',
    ]);
    expect(found.every((p) => p.source === 'tcp')).toBe(true);
  });

  it('does not list a host that only answers on 515', async () => {
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [],
      probe: async () => 'closed',
    });
    expect(found).toEqual([]);
  });

  it('drops an mDNS LPR/IPP advertisement on 515', async () => {
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [
        { ip: '192.168.33.20', port: 515, name: 'Some NAS share' },
        { ip: '192.168.33.20', port: 631, name: 'CUPS' },
      ],
      probe: async () => 'closed',
    });
    expect(found).toEqual([]);
  });

  it('keeps an mDNS JetDirect name when 9100 also answers', async () => {
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [
        { ip: '192.168.1.87', port: 9100, name: 'EPSON TM-T20' },
      ],
      probe: async (host) => (host === '192.168.1.87' ? 'printer' : 'closed'),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ip: '192.168.1.87',
      port: 9100,
      name: 'EPSON TM-T20',
      source: 'mdns',
    });
  });

  it('still lists an mDNS printer the TCP probe missed', async () => {
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [
        { ip: '192.168.1.87', port: 9100, name: 'Kitchen printer' },
      ],
      probe: async () => 'closed',
    });
    expect(found).toEqual([
      {
        ip: '192.168.1.87',
        port: 9100,
        name: 'Kitchen printer',
        source: 'mdns',
      },
    ]);
  });

  it('does not probe this machine', async () => {
    const probed: string[] = [];
    await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.252' }],
      discoverMdns: async () => [],
      probe: async (host) => {
        probed.push(host);
        return 'closed';
      },
    });
    expect(probed).not.toContain('192.168.1.50');
  });

  it('keeps a handful of silent JetDirect sockets', async () => {
    const silent = new Set(['192.168.1.10', '192.168.1.11']);
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [],
      probe: async (host) => (silent.has(host) ? 'open' : 'closed'),
    });
    expect(found.map((p) => p.ip).sort()).toEqual([
      '192.168.1.10',
      '192.168.1.11',
    ]);
  });

  it('does not list a whole subnet of silent 9100 timeouts', async () => {
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [
        { ip: '192.168.1.87', port: 9100, name: 'EPSON TM-T20' },
      ],
      probe: async (host) => (host === '192.168.1.87' ? 'printer' : 'open'),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ip: '192.168.1.87',
      name: 'EPSON TM-T20',
      source: 'mdns',
    });
  });

  it('drops an all-silent flood with no confirmed printer', async () => {
    const found = await scanNetworkPrinters({
      interfaces: [{ address: '192.168.1.50', netmask: '255.255.255.0' }],
      discoverMdns: async () => [],
      probe: async () => 'open',
    });
    expect(found).toEqual([]);
    expect(MAX_UNCONFIRMED_TCP).toBeLessThan(253);
  });
});

describe('classify9100Response', () => {
  it('keeps a silent JetDirect socket — cheap printers often send nothing', () => {
    expect(classify9100Response(Buffer.alloc(0))).toBe('accept');
  });

  it('recognises an Epson-style DLE EOT status byte', () => {
    expect(classify9100Response(Buffer.from([0x12]))).toBe('printer');
    expect(classify9100Response(Buffer.from([0x16]))).toBe('printer');
  });

  it('rejects services that just happen to listen on 9100', () => {
    expect(classify9100Response(Buffer.from('HTTP/1.1 200 OK\r\n'))).toBe(
      'reject',
    );
    expect(classify9100Response(Buffer.from('SSH-2.0-OpenSSH_9.0'))).toBe(
      'reject',
    );
    expect(classify9100Response(Buffer.from('220 mail.example ESMTP'))).toBe(
      'reject',
    );
    expect(classify9100Response(Buffer.from([0x16, 0x03, 0x01, 0x00]))).toBe(
      'reject',
    );
  });
});

describe('resultFrom9100Socket', () => {
  it('rejects a timeout that never connected', () => {
    expect(resultFrom9100Socket(false, Buffer.alloc(0))).toBe('closed');
  });

  it('treats a connected silent socket as an unconfirmed JetDirect', () => {
    expect(resultFrom9100Socket(true, Buffer.alloc(0))).toBe('open');
  });

  it('confirms an Epson-style status byte', () => {
    expect(resultFrom9100Socket(true, Buffer.from([0x12]))).toBe('printer');
  });

  it('rejects a banner even after connect', () => {
    expect(resultFrom9100Socket(true, Buffer.from('HTTP/1.1 200 OK\r\n'))).toBe(
      'closed',
    );
  });
});
