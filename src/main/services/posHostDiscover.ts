/**
 * Find POS hosts on the LAN for the standalone KDS app.
 *
 * Two methods run together:
 *   1. mDNS `_codeorbit-pos._tcp` (the POS advertiser).
 *   2. HTTP GET `/kds/debug` across this machine's /24 — works when
 *      multicast is blocked (common on kitchen Wi-Fi / Android hotspots).
 */
import os from 'node:os';
import { buildLanHttpUrl, pickBestLanAddress } from '@shared/lanHost';
import {
  hostFromDebugBody,
  hostsInSlash24,
  mapPool,
  mergeDiscoveredPosHosts,
  POS_LAN_HTTP_PORT,
  type DiscoveredPosHost,
} from '@shared/posHostDiscovery';
import { isPrivateIpv4, localLanInterfaces } from './networkPrinterScan';

const MDNS_WAIT_MS = 3500;
const HTTP_TIMEOUT_MS = 500;
const HTTP_CONCURRENCY = 32;

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

async function discoverViaMdns(waitMs: number): Promise<DiscoveredPosHost[]> {
  const found: DiscoveredPosHost[] = [];
  try {
    const { Bonjour } = await import('bonjour-service');
    const b = new Bonjour();
    await new Promise<void>((resolve) => {
      const browser = b.find(
        { type: 'codeorbit-pos', protocol: 'tcp' },
        (svc) => {
          const addresses = Array.isArray((svc as any).addresses)
            ? ((svc as any).addresses as string[])
            : [];
          const txt = (svc.txt || {}) as Record<string, string>;
          const txtHost = String(txt.lanHost || txt.host || '').trim();
          const host = pickBestLanAddress([
            ...(txtHost ? [txtHost] : []),
            ...addresses,
          ]);
          if (!host) return;
          const restaurantName = String(
            txt.restaurantName || txt.name || '',
          ).trim();
          found.push({
            name:
              restaurantName ||
              String((svc as any).name || '').trim() ||
              'OneTap POS',
            host,
            httpPort: Number(svc.port) || POS_LAN_HTTP_PORT,
            httpsPort: Number(txt.https) || undefined,
            restaurantName: restaurantName || undefined,
            businessCode: txt.businessCode || undefined,
            source: 'mdns',
          });
        },
      );
      setTimeout(() => {
        try {
          browser.stop();
          b.destroy();
        } catch {
          // ignore
        }
        resolve();
      }, waitMs);
    });
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn('[pos-discover] mDNS failed:', e);
    }
  }
  return found;
}

function localIpv4s(): string[] {
  const out: string[] = [];
  try {
    for (const ni of localLanInterfaces(os.networkInterfaces())) {
      if (isPrivateIpv4(ni.address)) out.push(ni.address);
    }
  } catch {
    // ignore
  }
  return out;
}

async function discoverViaHttpScan(): Promise<DiscoveredPosHost[]> {
  const selfIps = localIpv4s().slice(0, 2);
  const targets = new Set<string>();
  for (const ip of selfIps) {
    for (const h of hostsInSlash24(ip, ip)) targets.add(h);
  }
  // Same-machine POS during development.
  targets.add('127.0.0.1');
  const hits = await mapPool([...targets], HTTP_CONCURRENCY, (host) =>
    probePosHttp(host, POS_LAN_HTTP_PORT),
  );
  return hits.filter((h): h is DiscoveredPosHost => Boolean(h));
}

export async function discoverPosHostsOnLan(): Promise<DiscoveredPosHost[]> {
  const [mdns, http] = await Promise.all([
    discoverViaMdns(MDNS_WAIT_MS),
    discoverViaHttpScan(),
  ]);
  return mergeDiscoveredPosHosts([...mdns, ...http]);
}
