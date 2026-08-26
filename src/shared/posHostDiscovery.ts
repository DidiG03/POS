import { isIpv4Address, isLinkLocalOrLoopbackAddress } from './lanHost';

export const POS_LAN_HTTP_PORT = 3333;
export const POS_APP_ID = 'code-orbit-pos';

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
    name: restaurantName || 'Code Orbit POS',
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
        name: h.name || h.restaurantName || 'Code Orbit POS',
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
