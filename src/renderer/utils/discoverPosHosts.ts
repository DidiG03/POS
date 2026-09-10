import { buildLanHttpUrl } from '@shared/lanHost';
import {
  collectLanScanHosts,
  hostFromDebugBody,
  isPrivateIpv4,
  mapPool,
  mergeDiscoveredPosHosts,
  POS_LAN_HTTP_PORT,
  type DiscoveredPosHost,
} from '@shared/posHostDiscovery';

const HTTP_TIMEOUT_MS = 500;
const HTTP_CONCURRENCY = 24;
const SEED_TIMEOUT_MS = 2500;

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

function scanTargets(localIps: string[], extraIps: string[] = []): string[] {
  return collectLanScanHosts(localIps, extraIps);
}

/**
 * Find POS tills on the Wi-Fi. Used by waiter tablets and as a fallback
 * when the KDS app has no native discover IPC.
 */
export async function discoverPosHostsInBrowser(opts?: {
  seeds?: string[];
  httpPort?: number;
}): Promise<DiscoveredPosHost[]> {
  const native = (window as any).kdsApp as
    | { discover?: () => Promise<DiscoveredPosHost[]> }
    | undefined;
  const nativePromise = native?.discover
    ? native.discover().catch(() => [] as DiscoveredPosHost[])
    : Promise.resolve([] as DiscoveredPosHost[]);

  const port = Number(opts?.httpPort) || POS_LAN_HTTP_PORT;
  const seeds = [...new Set((opts?.seeds || []).map((s) => s.trim()))].filter(
    isPrivateIpv4,
  );

  // Hit the typed/saved IP first. iOS uses that request to show the Local
  // Network permission prompt; flooding the /24 before the user taps Allow
  // makes every probe fail.
  const seedHits = await Promise.all(
    seeds.map((host) => probePosHttp(host, port, SEED_TIMEOUT_MS)),
  );

  const localIps = await guessLocalIpv4s();
  const seedSet = new Set(seeds);
  const rest = scanTargets(localIps, seeds).filter((h) => !seedSet.has(h));
  const httpHits = await mapPool(rest, HTTP_CONCURRENCY, (host) =>
    probePosHttp(host, port),
  );
  const http = [...seedHits, ...httpHits].filter((h): h is DiscoveredPosHost =>
    Boolean(h),
  );
  const mdns = await nativePromise;
  return mergeDiscoveredPosHosts([...mdns, ...http]);
}
