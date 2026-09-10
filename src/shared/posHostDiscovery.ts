import { isIpv4Address, isLinkLocalOrLoopbackAddress } from './lanHost';

export const POS_LAN_HTTP_PORT = 3333;
export const POS_APP_ID = 'code-orbit-pos';
/** Used only when the phone cannot learn its own LAN IP (common on iOS). */
export const POS_SCAN_FALLBACK_SEEDS = ['192.168.1.1', '192.168.0.1'];

export type DiscoveredPosHost = {
  name: string;
  host: string;
  httpPort: number;
  httpsPort?: number;
  restaurantName?: string;
  businessCode?: string;
  source?: 'mdns' | 'http';
};

export function isPrivateIpv4(ip: string): boolean {
  if (!isIpv4Address(ip) || isLinkLocalOrLoopbackAddress(ip)) return false;
  const p = ip.split('.').map(Number);
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

/** Other hosts on the same /24. Caps work to 254 probes. */
export function hostsInSlash24(address: string, skipSelf?: string): string[] {
  if (!isPrivateIpv4(address)) return [];
  const parts = String(address)
    .trim()
    .split('.')
    .map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return [];
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const skip = String(skipSelf || address).trim();
  const out: string[] = [];
  for (let i = 1; i <= 254; i += 1) {
    const ip = `${prefix}.${i}`;
    if (ip === skip) continue;
    out.push(ip);
  }
  return out;
}

/**
 * IPv4s a waiter phone should probe for a POS on port 3333.
 * `extraIps` is the address the user typed (or last saved) so we scan that
 * /24 even when WebRTC does not reveal the phone's own subnet.
 */
export function collectLanScanHosts(
  localIps: string[],
  extraIps: string[] = [],
  fallbackSeeds: string[] = POS_SCAN_FALLBACK_SEEDS,
): string[] {
  const nets = new Set<string>();
  const addNet = (ip: string) => {
    if (!isPrivateIpv4(ip)) return;
    const parts = ip.split('.');
    nets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
  };
  for (const ip of localIps) addNet(ip);
  for (const ip of extraIps) addNet(ip);
  if (nets.size === 0) {
    for (const seed of fallbackSeeds) addNet(seed);
  } else if (nets.size > 2) {
    const preferred = extraIps.filter(isPrivateIpv4);
    const keep: string[] = [];
    for (const ip of [...preferred, ...localIps]) {
      const parts = ip.split('.');
      if (parts.length !== 4) continue;
      const net = `${parts[0]}.${parts[1]}.${parts[2]}`;
      if (nets.has(net) && !keep.includes(net)) keep.push(net);
      if (keep.length >= 2) break;
    }
    if (keep.length > 0) {
      nets.clear();
      for (const n of keep) nets.add(n);
    }
  }
  const skip = new Set(localIps.filter(isPrivateIpv4));
  const hosts = new Set<string>();
  for (const ip of extraIps) {
    if (isPrivateIpv4(ip) && !skip.has(ip)) hosts.add(ip);
  }
  for (const net of nets) {
    const gateway = `${net}.1`;
    if (!skip.has(gateway) && isPrivateIpv4(gateway)) hosts.add(gateway);
    for (const h of hostsInSlash24(gateway)) {
      if (!skip.has(h)) hosts.add(h);
    }
  }
  return [...hosts];
}

export function isPosDebugBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  if (rec.app === POS_APP_ID) return true;
  return typeof rec.schemaReady === 'boolean';
}

export function hostFromDebugBody(
  host: string,
  httpPort: number,
  body: unknown,
  source: DiscoveredPosHost['source'] = 'http',
): DiscoveredPosHost | null {
  if (!isPosDebugBody(body)) return null;
  const rec = (body || {}) as Record<string, unknown>;
  const restaurantName = String(rec.restaurantName || '').trim() || undefined;
  return {
    host,
    httpPort,
    httpsPort: Number(rec.httpsPort) || undefined,
    restaurantName,
    businessCode: String(rec.businessCode || '').trim() || undefined,
    name: restaurantName || 'OneTap POS',
    source,
  };
}

export function mergeDiscoveredPosHosts(
  list: DiscoveredPosHost[],
): DiscoveredPosHost[] {
  const map = new Map<string, DiscoveredPosHost>();
  for (const h of list) {
    const host = String(h?.host || '').trim();
    const httpPort = Number(h?.httpPort) || POS_LAN_HTTP_PORT;
    if (!host) continue;
    const key = `${host}:${httpPort}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...h,
        host,
        httpPort,
        name: h.name || h.restaurantName || 'OneTap POS',
      });
      continue;
    }
    map.set(key, {
      ...prev,
      ...h,
      host,
      httpPort,
      name: h.name || prev.name,
      restaurantName: h.restaurantName || prev.restaurantName,
      businessCode: h.businessCode || prev.businessCode,
      httpsPort: h.httpsPort || prev.httpsPort,
      source: prev.source === 'mdns' || h.source === 'mdns' ? 'mdns' : 'http',
    });
  }
  return [...map.values()].sort((a, b) => {
    if (a.host !== b.host) return a.host.localeCompare(b.host);
    return a.httpPort - b.httpPort;
  });
}

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx]);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
