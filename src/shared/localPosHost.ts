export function stripIpv4MappedPrefix(ip: string): string {
  const raw = String(ip || '').trim();
  if (raw.toLowerCase().startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

/** True when the peer is this machine (loopback or one of our LAN NICs). */
export function isThisMachineAddress(
  ip: string | null | undefined,
  localAddresses: string[],
): boolean {
  const host = stripIpv4MappedPrefix(String(ip || '')).toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1')
    return true;
  if (host.startsWith('127.')) return true;
  const locals = new Set(
    (localAddresses || []).map((a) =>
      stripIpv4MappedPrefix(String(a || '')).toLowerCase(),
    ),
  );
  return locals.has(host);
}

/** Same-machine Admin/KDS should talk to 127.0.0.1 so the till sees loopback. */
export function httpHostForLocalPos(
  host: string,
  localAddresses: string[],
): string {
  const trimmed = String(host || '').trim();
  if (!trimmed) return trimmed;
  return isThisMachineAddress(trimmed, localAddresses) ? '127.0.0.1' : trimmed;
}
