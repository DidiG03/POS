import { buildLanHttpUrl } from '@shared/lanHost';
import {
  hostFromDebugBody,
  hostsInSlash24,
  isPrivateIpv4,
  mapPool,
  mergeDiscoveredPosHosts,
  POS_LAN_HTTP_PORT,
  type DiscoveredPosHost,
} from '@shared/posHostDiscovery';

const HTTP_TIMEOUT_MS = 500;
const HTTP_CONCURRENCY = 24;
const FALLBACK_SEEDS = ['192.168.1.1', '192.168.0.1'];

function parseIpv4FromCandidate(line: string): string | null {
  const m = String(line || '').match(
    /(?:candidate:\S+\s+\d+\s+\S+\s+\d+\s+)(\d{1,3}(?:\.\d{1,3}){3})/i,
  );
  return m ? m[1] : null;
}

/** Best-effort this-device IPv4 via WebRTC ICE (works on many Android WebViews). */
export async function guessLocalIpv4s(timeoutMs = 1200): Promise<string[]> {
  const found = new Set<string>();
  if (typeof RTCPeerConnection === 'undefined') return [];
  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('pos');
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const t = setTimeout(done, timeoutMs);
      pc!.onicecandidate = (ev) => {
        const c = ev.candidate;
        if (!c) {
          clearTimeout(t);
          done();
          return;
        }
        const ip =
          (c as RTCIceCandidate & { address?: string }).address ||
          parseIpv4FromCandidate(c.candidate);
        if (ip && isPrivateIpv4(ip)) found.add(ip);
      };
      pc!
        .createOffer()
        .then((offer) => pc!.setLocalDescription(offer))
        .catch(() => {
          clearTimeout(t);
          done();
        });
    });
  } catch {
    // ignore
  } finally {
    try {
      pc?.close();
    } catch {
      // ignore
    }
  }
  return [...found];
}

export async function probePosHttp(
  host: string,
  httpPort: number,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<DiscoveredPosHost | null> {
  const url = buildLanHttpUrl(host, httpPort, '/kds/debug');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return null;
    const body = await r.json().catch(() => null);
    return hostFromDebugBody(host, httpPort, body, 'http');
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function scanTargets(localIps: string[]): string[] {
  const nets = new Set<string>();
  const addNet = (ip: string) => {
    const parts = ip.split('.');
    if (parts.length === 4) nets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
  };
  for (const ip of localIps) addNet(ip);
  if (nets.size === 0) {
    for (const seed of FALLBACK_SEEDS) addNet(seed);
  } else if (nets.size > 2) {
    // Don't walk every VPN/interface; keep the scan to a couple of /24s.
    const keep = [...nets].slice(0, 2);
    nets.clear();
    for (const n of keep) nets.add(n);
  }
  const skip = new Set(localIps);
  const hosts = new Set<string>();
  for (const net of nets) {
    const seed = `${net}.1`;
    for (const h of hostsInSlash24(seed)) {
      if (!skip.has(h)) hosts.add(h);
    }
  }
  return [...hosts];
}

/**
 * Find POS tills on the Wi-Fi. Used by waiter tablets and as a fallback
 * when the KDS app has no native discover IPC.
 */
export async function discoverPosHostsInBrowser(): Promise<
  DiscoveredPosHost[]
> {
  const native = (window as any).kdsApp as
    | { discover?: () => Promise<DiscoveredPosHost[]> }
    | undefined;
  const nativePromise = native?.discover
    ? native.discover().catch(() => [] as DiscoveredPosHost[])
    : Promise.resolve([] as DiscoveredPosHost[]);

  const localIps = await guessLocalIpv4s();
  const targets = scanTargets(localIps);
  const httpHits = await mapPool(targets, HTTP_CONCURRENCY, (host) =>
    probePosHttp(host, POS_LAN_HTTP_PORT),
  );
  const http = httpHits.filter((h): h is DiscoveredPosHost => Boolean(h));
  const mdns = await nativePromise;
  return mergeDiscoveredPosHosts([...mdns, ...http]);
}
