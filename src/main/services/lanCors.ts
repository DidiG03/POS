/**
 * Which browser origins may call the POS LAN API, and which clients skip
 * the "Allow Web access" toggle.
 *
 * Scan/discover runs in the Electron *main* process (no CORS). Admin/KDS
 * login then `fetch`es from the renderer (localhost Vite or file://) onto
 * a private LAN IP. Chromium treats that as a cross-origin private-network
 * request and blocks it unless we allow the companion origin and answer
 * the Private Network Access preflight.
 */
import { CAPACITOR_WEBVIEW_ORIGINS } from '@shared/capacitorWebviewOrigins';
import type { IncomingMessage } from 'node:http';
import type { UrlWithParsedQuery } from 'node:url';

/** Vite / packaged Electron shells for POS, Admin, and KDS. */
export const ELECTRON_COMPANION_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'file://',
] as const;

export function posClientMarker(
  req: IncomingMessage,
  parsed?: UrlWithParsedQuery,
): string {
  const headerVal = req.headers['x-pos-client'];
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (header) return String(header).toLowerCase().trim();
  const query = parsed?.query?.client;
  const q = Array.isArray(query) ? query[0] : query;
  return String(q || '')
    .toLowerCase()
    .trim();
}

export function isNativeClient(
  req: IncomingMessage,
  parsed?: UrlWithParsedQuery,
): boolean {
  return posClientMarker(req, parsed) === 'native';
}

/** OneTap Admin / KDS Electron apps, not a random page on the LAN. */
export function isElectronCompanionOrigin(origin: string | undefined): boolean {
  const raw = String(origin || '').trim();
  if (raw === 'null' || raw === 'file://') return true;
  try {
    const o = new URL(raw);
    return o.hostname === 'localhost' || o.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function isTrustedLanClient(
  req: IncomingMessage,
  parsed?: UrlWithParsedQuery,
  origin?: string,
): boolean {
  if (isNativeClient(req, parsed)) return true;
  const marker = posClientMarker(req, parsed);
  if (marker !== 'admin' && marker !== 'kds') return false;
  return isElectronCompanionOrigin(origin);
}

export function allowLanCorsOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  extra: string[] = [],
): string | null {
  if (!origin) return null;
  if (origin === 'null') return 'null';
  const allowList = new Set<string>([
    ...extra,
    ...ELECTRON_COMPANION_ORIGINS,
    ...CAPACITOR_WEBVIEW_ORIGINS,
  ]);
  try {
    const o = new URL(origin);
    const host = (hostHeader || '').split(',')[0]?.trim() || '';
    const hostNoPort = host.includes(':') ? host.split(':')[0] : host;
    if (o.hostname === hostNoPort) return origin;
    if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') return origin;
  } catch {
    // ignore
  }
  if (allowList.has(origin)) return origin;
  return null;
}
