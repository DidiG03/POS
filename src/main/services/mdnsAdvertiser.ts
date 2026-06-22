/**
 * POS host: advertise the LAN API server on multicast DNS so the
 * dedicated KDS app (and, in the future, mobile waiters) can discover
 * the host without typing IPs.
 *
 * Service name: `_codeorbit-pos._tcp.local.`
 * TXT records:
 *   - version       app version (informational)
 *   - https         HTTPS port (so a KDS that prefers TLS can use it)
 *   - businessCode  optional, helps in shared LANs with multiple sites
 *   - lanHost       primary IPv4 of the POS machine (stable connect hint)
 *
 * Kept very small on purpose: the existing HTTP server already handles
 * all auth/data — mDNS is only for the "find my POS" handshake.
 */
import type { Bonjour, Service } from 'bonjour-service';
import os from 'node:os';
import { pickBestLanAddress } from '@shared/lanHost';

let bonjour: Bonjour | null = null;
let service: Service | null = null;
let started = false;

export type AdvertiseInput = {
  httpPort: number;
  httpsPort?: number;
  appVersion?: string;
  businessCode?: string;
};

function primaryLanIpv4(): string {
  const ips: string[] = [];
  try {
    const nets = os.networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const ni of list || []) {
        if (!ni || ni.internal) continue;
        const family = String((ni as any).family || '');
        if (family !== 'IPv4' && family !== '4') continue;
        if (ni.address) ips.push(String(ni.address));
      }
    }
  } catch {
    // ignore
  }
  return pickBestLanAddress(ips) || '';
}

function safeHost(): string {
  try {
    const h = os.hostname() || 'pos';
    return h.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 30) || 'pos';
  } catch {
    return 'pos';
  }
}

export async function startMdnsAdvertiser(
  input: AdvertiseInput,
): Promise<void> {
  if (started) return;
  started = true;
  try {
    const { Bonjour } = await import('bonjour-service');
    bonjour = new Bonjour();
    const lanHost = primaryLanIpv4();
    service = bonjour.publish({
      name: `Code Orbit POS @ ${safeHost()}`,
      type: 'codeorbit-pos',
      protocol: 'tcp',
      port: input.httpPort,
      txt: {
        version: String(input.appVersion || '0'),
        https: String(input.httpsPort || ''),
        businessCode: String(input.businessCode || ''),
        lanHost,
      },
    });
  } catch (e) {
    started = false;
    bonjour = null;
    service = null;
    if (typeof console !== 'undefined') {
      console.warn('[mdns] failed to start advertiser:', e);
    }
  }
}

export async function stopMdnsAdvertiser(): Promise<void> {
  try {
    if (service && typeof (service as any).stop === 'function') {
      await new Promise<void>((resolve) => {
        try {
          (service as any).stop(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  } catch {
    // ignore
  }
  try {
    if (bonjour) bonjour.destroy();
  } catch {
    // ignore
  }
  service = null;
  bonjour = null;
  started = false;
}
