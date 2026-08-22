/**
 * Find ESC/POS receipt printers on the local network.
 *
 * An open socket is not enough: port 515 (LPR) is also CUPS, macOS
 * printer-sharing and a lot of NAS boxes, and even 9100 is sometimes a
 * web admin or some other service. So the scan:
 *
 *   1. Probes TCP 9100 only (JetDirect / raw ESC/POS). 515 is ignored.
 *   2. Asks whatever answered for printer status (`DLE EOT`) and drops
 *      anything that replies with HTTP, SSH, TLS, SMTP, …
 *   3. Listens for mDNS `_pdl-datastream._tcp` (the JetDirect name).
 *      `_ipp._tcp` and `_printer._tcp` are skipped — those are usually
 *      computers sharing a queue, not a till printer.
 *
 * Subnets wider than /24 are capped to the host's /24 so a misconfigured
 * mask cannot send 65,000 SYNs. Public and link-local addresses are skipped.
 */

import net from 'node:net';
import os from 'node:os';
import { isIpv4Address, isLinkLocalOrLoopbackAddress } from '@shared/lanHost';
import type { NetworkPrinterDTO } from '@shared/ipc';

export const RAW_PRINTER_PORT = 9100;
export const PROBE_TIMEOUT_MS = 400;
export const SCAN_CONCURRENCY = 48;
export const MDNS_WAIT_MS = 2500;

/** ESC/POS real-time printer status. Does not print anything. */
const DLE_EOT_PRINTER_STATUS = Buffer.from([0x10, 0x04, 0x01]);

export type PrinterProbe = (
  host: string,
  timeoutMs: number,
) => Promise<boolean>;

export interface LanInterface {
  address: string;
  netmask: string;
  internal?: boolean;
}

export interface MdnsHit {
  ip: string;
  port: number;
  name: string;
}

export function ipv4ToInt(ip: string): number {
  const p = String(ip)
    .split('.')
    .map((n) => Number(n));
  if (
    p.length !== 4 ||
    p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return 0;
  }
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(
    '.',
  );
}

export function isPrivateIpv4(ip: string): boolean {
  if (!isIpv4Address(ip) || isLinkLocalOrLoopbackAddress(ip)) return false;
  const n = ipv4ToInt(ip);
  if (n >>> 24 === 10) return true;
  if (n >>> 24 === 172 && ((n >>> 16) & 0xf0) === 16) return true;
  if (n >>> 16 === 0xc0a8) return true;
  return false;
}

function cidrFromNetmask(mask: string): number {
  const n = ipv4ToInt(mask);
  let bits = 0;
  for (let i = 31; i >= 0; i -= 1) {
    if (((n >>> i) & 1) === 0) break;
    bits += 1;
  }
  return bits;
}

/**
 * Hosts to probe on one interface. Network/broadcast/self are skipped.
 * Masks shorter than /24 are treated as /24 around the host.
 */
export function hostsInSubnet(address: string, netmask: string): string[] {
  if (!isPrivateIpv4(address)) return [];
  const ip = ipv4ToInt(address);
  const cidr = cidrFromNetmask(netmask);
  const maskInt =
    cidr > 0 && cidr < 24 ? ipv4ToInt('255.255.255.0') : ipv4ToInt(netmask);
  if (maskInt === 0) return [];
  const network = (ip & maskInt) >>> 0;
  const broadcast = (network | (~maskInt >>> 0)) >>> 0;
  const out: string[] = [];
  for (let h = network + 1; h < broadcast; h += 1) {
    const addr = intToIpv4(h);
    if (addr === address) continue;
    out.push(addr);
  }
  return out;
}

export function localLanInterfaces(
  nets: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanInterface[] {
  const out: LanInterface[] = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (!ni || ni.internal) continue;
      const family = String((ni as { family?: string | number }).family || '');
      if (family !== 'IPv4' && family !== '4') continue;
      if (!isPrivateIpv4(ni.address)) continue;
      out.push({
        address: String(ni.address),
        netmask: String(ni.netmask || '255.255.255.0'),
      });
    }
  }
  return out;
}

/**
 * Decide whether a 9100 reply is an ESC/POS printer, some other service,
 * or just a silent JetDirect socket (typical of cheap thermal printers).
 *
 * Exported so the tests can pin the banner rules without opening sockets.
 */
export function classify9100Response(
  data: Buffer,
): 'printer' | 'reject' | 'accept' {
  if (!data.length) return 'accept';
  if (looksLikeNonPrinterBanner(data)) return 'reject';
  // DLE EOT n=1: bits 1 and 4 are fixed at 1 on Epson-compatible printers.
  if (data.length <= 4 && (data[0] & 0x12) === 0x12) return 'printer';
  return 'accept';
}

export function looksLikeNonPrinterBanner(data: Buffer): boolean {
  if (!data.length) return false;
  if (data[0] === 0x16 && data[1] === 0x03) return true; // TLS Client/Server Hello
  const head = data.subarray(0, 96).toString('latin1');
  const t = head.toLowerCase();
  if (t.startsWith('ssh-')) return true;
  if (/^http\/[0-9]/.test(t) || t.includes('http/1.') || t.includes('http/2')) {
    return true;
  }
  if (t.includes('<html') || t.includes('<!doctype')) return true;
  // FTP and SMTP greet with "220 " / "220-"
  if (/^220[\s-]/.test(head)) return true;
  if (t.startsWith('rfb ')) return true;
  if (t.startsWith('*') && t.includes('redis')) return true;
  if (/^\* ok /i.test(head)) return true; // IMAP
  if (/^\+ok\b/i.test(head)) return true; // POP3
  return false;
}

export function probeEscposPrinter(
  host: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(Math.max(80, timeoutMs));
    socket.once('connect', () => {
      try {
        socket.write(DLE_EOT_PRINTER_STATUS);
      } catch {
        done(false);
      }
    });
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      const kind = classify9100Response(Buffer.concat(chunks));
      if (kind === 'reject') done(false);
      else if (kind === 'printer') done(true);
    });
    socket.once('timeout', () => {
      done(classify9100Response(Buffer.concat(chunks)) !== 'reject');
    });
    socket.once('error', () => done(false));
    socket.once('close', () => {
      if (settled) return;
      done(classify9100Response(Buffer.concat(chunks)) !== 'reject');
    });
    try {
      socket.connect(RAW_PRINTER_PORT, host);
    } catch {
      done(false);
    }
  });
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

async function discoverMdnsPrinters(waitMs: number): Promise<MdnsHit[]> {
  let Bonjour: typeof import('bonjour-service').Bonjour;
  try {
    ({ Bonjour } = await import('bonjour-service'));
  } catch {
    return [];
  }
  const bonjour = new Bonjour();
  const found = new Map<string, MdnsHit>();
  const remember = (svc: {
    name?: string;
    host?: string;
    port?: number;
    addresses?: string[];
    referer?: { address?: string };
  }) => {
    const addrs = [
      ...(svc.addresses || []),
      svc.referer?.address,
      // `host` is often `Name.local`; only keep it if it is already an IP.
      isIpv4Address(String(svc.host || '')) ? String(svc.host) : '',
    ].filter(Boolean) as string[];
    const ipv4 = addrs.find((a) => isPrivateIpv4(a));
    if (!ipv4) return;
    const rawName = String(svc.name || svc.host || '')
      .replace(/\.local\.?$/i, '')
      .trim();
    const key = ipv4;
    const existing = found.get(key);
    if (existing && existing.name && !rawName) return;
    found.set(key, {
      ip: ipv4,
      port: RAW_PRINTER_PORT,
      name: rawName || `Printer at ${ipv4}`,
    });
  };
  // JetDirect / AppSocket. `_printer` and `_ipp` light up laptops and
  // NAS boxes that share a queue — not the till printer itself.
  const browser = bonjour.find({ type: 'pdl-datastream' }, remember);
  await new Promise((r) => setTimeout(r, waitMs));
  try {
    browser.stop();
  } catch {
    // ignore
  }
  try {
    bonjour.destroy();
  } catch {
    // ignore
  }
  return [...found.values()];
}

function mergePrinters(
  tcp: Array<{ ip: string; port: number }>,
  mdns: MdnsHit[],
): NetworkPrinterDTO[] {
  const byIp = new Map<string, NetworkPrinterDTO>();
  const prefer = (next: NetworkPrinterDTO) => {
    const existing = byIp.get(next.ip);
    if (!existing) {
      byIp.set(next.ip, next);
      return;
    }
    // One row per IP. An mDNS name wins over a bare TCP hit so the
    // dropdown shows "EPSON TM-T20" not just an address.
    const named =
      next.source === 'mdns' && next.name
        ? next
        : existing.source === 'mdns' && existing.name
          ? existing
          : next.source === 'mdns'
            ? next
            : existing;
    byIp.set(next.ip, {
      ip: next.ip,
      port: RAW_PRINTER_PORT,
      name: named.name,
      source: named.source,
    });
  };
  for (const p of tcp) {
    prefer({
      ip: p.ip,
      port: p.port,
      name: `Printer at ${p.ip}`,
      source: 'tcp',
    });
  }
  for (const p of mdns) prefer({ ...p, source: 'mdns' });
  return [...byIp.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'mdns' ? -1 : 1;
    return a.ip.localeCompare(b.ip, undefined, { numeric: true });
  });
}

export async function scanNetworkPrinters(options?: {
  probe?: PrinterProbe;
  interfaces?: LanInterface[];
  discoverMdns?: () => Promise<MdnsHit[]>;
  timeoutMs?: number;
  concurrency?: number;
}): Promise<NetworkPrinterDTO[]> {
  const probe = options?.probe || probeEscposPrinter;
  const ifaces = options?.interfaces || localLanInterfaces();
  const timeoutMs = options?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const concurrency = options?.concurrency ?? SCAN_CONCURRENCY;
  const self = new Set(ifaces.map((i) => i.address));

  const hosts = [
    ...new Set(ifaces.flatMap((i) => hostsInSubnet(i.address, i.netmask))),
  ].filter((h) => !self.has(h));

  const mdnsPromise = (
    options?.discoverMdns || (() => discoverMdnsPrinters(MDNS_WAIT_MS))
  )().catch(() => [] as MdnsHit[]);

  const tcpHits: Array<{ ip: string; port: number }> = [];
  await mapPool(hosts, concurrency, async (host) => {
    if (await probe(host, timeoutMs)) {
      tcpHits.push({ ip: host, port: RAW_PRINTER_PORT });
    }
  });

  const mdns = (await mdnsPromise).filter(
    (p) => isPrivateIpv4(p.ip) && Number(p.port) === RAW_PRINTER_PORT,
  );
  return mergePrinters(tcpHits, mdns);
}
