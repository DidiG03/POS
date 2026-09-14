import { normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Resolve a request path to a file inside `rootDir`, or `null` when it escapes.
 *
 * The LAN host serves the built renderer to tablets over unauthenticated GETs.
 * Joining the request path onto the renderer directory without a containment
 * check lets `GET /renderer/../../../<anything>` read any file the POS process
 * can read — the local SQLite database with the whole day's takings included.
 * `node:http` hands us the path exactly as sent, so a client that does not
 * normalise (curl --path-as-is, or any non-browser) reaches it directly.
 */
export function resolveStaticFilePath(
  rootDir: string,
  requestPath: string,
): string | null {
  if (!rootDir) return null;
  let candidate = String(requestPath ?? '');

  // Percent escapes are still encoded in a parsed pathname, so decode before
  // validating — otherwise `%2e%2e` would be checked in its harmless form and
  // could be re-interpreted later.
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // A malformed escape is never a legitimate asset request.
    return null;
  }

  // A NUL byte truncates the path inside libuv, hiding whatever follows it.
  if (candidate.includes('\0')) return null;

  // Backslashes are path separators on Windows; normalise them so the
  // containment check cannot be sidestepped by `..\..\`.
  candidate = candidate.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!candidate) return null;

  const root = resolve(rootDir);
  const full = resolve(root, normalize(candidate));
  if (
    full !== root &&
    !full.startsWith(root.endsWith(sep) ? root : root + sep)
  ) {
    return null;
  }
  return full;
}

/**
 * LAN tablets (Safari / Chrome / Capacitor WebView) cache `/renderer/`
 * aggressively. HTML must revalidate so a POS update swaps in the new hashed
 * JS. Use `no-cache` (revalidate) rather than `no-store` so back/forward cache
 * can still restore the till after a same-tab navigation.
 */
export function staticAssetCacheControl(filePath: string): string {
  const n = String(filePath || '').replace(/\\/g, '/');
  const base = n.split('/').pop() || '';
  if (!base || base === 'index.html' || n.endsWith('.html')) {
    return 'no-cache, must-revalidate';
  }
  if (/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(base)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-store';
}

/** Gzip HTML when the client asks for it (Lighthouse document compression). */
export function gzipHtmlIfAccepted(
  body: Buffer,
  contentType: string,
  acceptEncoding?: string,
): { body: Buffer; contentEncoding?: 'gzip' } {
  if (!contentType.includes('text/html')) return { body };
  if (!String(acceptEncoding || '').includes('gzip')) return { body };
  if (body.length < 32) return { body };
  return { body: gzipSync(body), contentEncoding: 'gzip' };
}
