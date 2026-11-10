/**
 * Which `Host` headers the LAN API answers.
 *
 * Requests from the till's own machine are trusted more than the network
 * (kitchen routes without a token, no pairing code). A web page open in a
 * browser on the till can point its own domain name at 127.0.0.1 (DNS
 * rebinding) and so become "this machine" to the API; the browser still
 * sends the page's domain as `Host`. OneTap apps reach the till by IP
 * address or by a name that only exists on the local network, so a public
 * domain name in `Host` is refused.
 *
 * Accepted: IP addresses, `localhost`, names without a dot, local-only
 * suffixes (`.local`, `.lan`, `.home`, `.home.arpa`, `.internal`,
 * `.localdomain`), this computer's own name, and anything listed in
 * `POS_ALLOWED_HOSTS`. A request with no `Host` at all is not from a
 * browser and is let through.
 */
import net from 'node:net';

const LOCAL_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.home.arpa',
  '.internal',
  '.localdomain',
  '.localhost',
];

/** The host part of a `Host` header, lower-cased, without port or brackets. */
export function hostnameFromHostHeader(
  header: string | string[] | undefined,
): string {
  const raw = String((Array.isArray(header) ? header[0] : header) || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : '';
  }
  // A bare IPv6 address has several colons and no port to strip.
  if (net.isIPv6(raw)) return raw;
  const colon = raw.lastIndexOf(':');
  const host = colon >= 0 ? raw.slice(0, colon) : raw;
  return host.replace(/\.$/, '');
}

export function lanHostHeaderAllowed(
  header: string | string[] | undefined,
  opts: { ownHostnames?: string[]; extra?: string[] } = {},
): boolean {
  const present = Array.isArray(header) ? header.length > 0 : Boolean(header);
  if (!present) return true;
  const host = hostnameFromHostHeader(header);
  if (!host) return false;
  if (net.isIP(host) !== 0) return true;
  if (host === 'localhost') return true;
  if (!/^[a-z0-9._-]+$/.test(host)) return false;
  if (!host.includes('.')) return true;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  const named = [...(opts.ownHostnames || []), ...(opts.extra || [])]
    .map((n) =>
      String(n || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, ''),
    )
    .filter(Boolean);
  return named.includes(host);
}

/** `POS_ALLOWED_HOSTS=till.example.com,pos.example.com` */
export function parseAllowedHostsEnv(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
