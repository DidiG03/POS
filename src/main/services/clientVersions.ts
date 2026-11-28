/**
 * Which app versions talk to this till.
 *
 * Phones are often updated later than the till. A Waiter app older than
 * the till still works, but some features need the same version (a 0.2.113
 * phone could not reprint against a 0.2.114 till), and nothing said so.
 * Every LAN request reports its app version; the till keeps, in memory,
 * when each version was last seen and from which device, and till health
 * names older ones.
 */
import { APP_VERSION, compareAppVersions } from '@shared/appVersion';

/** Versions seen in the last day count. */
export const CLIENT_VERSION_WINDOW_MS = 24 * 60 * 60 * 1000;

const seen = new Map<string, { version: string; at: number }>();
const MAX_DEVICES = 500;

/** Note one request: its app version and a device key (token, address). */
export function noteClientVersion(
  version: string | null | undefined,
  device: string,
  now = Date.now(),
): void {
  const v = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(v) || !device) return;
  if (!seen.has(device) && seen.size >= MAX_DEVICES) {
    const oldest = [...seen.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) seen.delete(oldest[0]);
  }
  seen.set(device, { version: v, at: now });
}

/** Devices seen in the last day on an app older than this till. */
export function olderClients(
  now = Date.now(),
  current: string = APP_VERSION,
): Array<{ version: string; devices: number }> {
  const byVersion = new Map<string, number>();
  for (const { version, at } of seen.values()) {
    if (now - at > CLIENT_VERSION_WINDOW_MS) continue;
    if (compareAppVersions(version, current) >= 0) continue;
    byVersion.set(version, (byVersion.get(version) ?? 0) + 1);
  }
  return [...byVersion.entries()]
    .map(([version, devices]) => ({ version, devices }))
    .sort((a, b) => compareAppVersions(a.version, b.version));
}

/** @internal vitest */
export function resetClientVersions(): void {
  seen.clear();
}
