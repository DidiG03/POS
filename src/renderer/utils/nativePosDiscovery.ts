import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  isPrivateIpv4,
  type DiscoveredPosHost,
} from '@shared/posHostDiscovery';

/**
 * Native helper in the OneTap Admin iPhone app
 * (ios-admin/App/App/PosDiscoveryPlugin.swift). WKWebView hides the phone's
 * own IP, so without it the scan cannot tell which Wi-Fi subnet to probe.
 * Other apps (waiter, browsers) don't have it and get empty answers.
 */
type PosDiscoveryPlugin = {
  localAddresses(): Promise<{ addresses?: string[] }>;
  browse(opts: { timeoutMs: number }): Promise<{
    hosts?: Array<Partial<DiscoveredPosHost>>;
  }>;
};

const PosDiscovery = registerPlugin<PosDiscoveryPlugin>('PosDiscovery');

function available(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() &&
      Capacitor.isPluginAvailable('PosDiscovery')
    );
  } catch {
    return false;
  }
}

/** The phone's own Wi-Fi IPv4 addresses, or [] when unknown. */
export async function nativeLocalIpv4s(): Promise<string[]> {
  if (!available()) return [];
  try {
    const r = await PosDiscovery.localAddresses();
    return (r.addresses || []).filter(isPrivateIpv4);
  } catch {
    return [];
  }
}

/** Tills advertising `_codeorbit-pos._tcp` on this Wi-Fi (Bonjour). */
export async function nativeBonjourPosHosts(
  timeoutMs = 3000,
): Promise<DiscoveredPosHost[]> {
  if (!available()) return [];
  try {
    const r = await PosDiscovery.browse({ timeoutMs });
    const out: DiscoveredPosHost[] = [];
    for (const h of r.hosts || []) {
      const host = String(h.host || '');
      const httpPort = Number(h.httpPort) || 0;
      if (!isPrivateIpv4(host) || httpPort <= 0) continue;
      out.push({
        name: String(h.name || 'OneTap POS'),
        host,
        httpPort,
        httpsPort: Number(h.httpsPort) || undefined,
        restaurantName: h.restaurantName || undefined,
        businessCode: h.businessCode || undefined,
        source: 'mdns',
      });
    }
    return out;
  } catch {
    return [];
  }
}
