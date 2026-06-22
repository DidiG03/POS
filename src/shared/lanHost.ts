const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIpv4Address(host: string): boolean {
  return IPV4_RE.test(String(host || '').trim());
}

export function isIpv6Address(host: string): boolean {
  const h = String(host || '').trim();
  return h.includes(':') && !isIpv4Address(h);
}

export function isLinkLocalOrLoopbackAddress(host: string): boolean {
  const h = String(host || '')
    .trim()
    .toLowerCase();
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.startsWith('fe80:')) return true;
  if (h.startsWith('169.254.')) return true;
  return false;
}

function ipv4SortScore(addr: string): number {
  if (addr.startsWith('192.168.')) return 0;
  if (addr.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 2;
  return 3;
}

/** Prefer private IPv4 for kitchen tablets / KDS on the same LAN. */
export function pickBestLanAddress(addresses: string[]): string | null {
  const list = (addresses || [])
    .map((a) => String(a || '').trim())
    .filter(Boolean);
  const ipv4 = list
    .filter(isIpv4Address)
    .filter((a) => !isLinkLocalOrLoopbackAddress(a));
  if (ipv4.length) {
    ipv4.sort((a, b) => ipv4SortScore(a) - ipv4SortScore(b));
    return ipv4[0];
  }
  const ipv6 = list
    .filter(isIpv6Address)
    .filter((a) => !isLinkLocalOrLoopbackAddress(a));
  if (ipv6.length) return ipv6[0];
  return null;
}

/** Wrap IPv6 literals in brackets for URL host segments. */
export function formatHostForUrl(host: string): string {
  const h = String(host || '').trim();
  if (!h) return h;
  if (h.startsWith('[') && h.endsWith(']')) return h;
  if (isIpv6Address(h)) return `[${h}]`;
  return h;
}

export function buildLanHttpUrl(
  host: string,
  port: number | string,
  path = '',
): string {
  const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `http://${formatHostForUrl(host)}:${port}${normalizedPath}`;
}

export function buildLanHttpsUrl(
  host: string,
  port: number | string,
  path = '',
): string {
  const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `https://${formatHostForUrl(host)}:${port}${normalizedPath}`;
}
