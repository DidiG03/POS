import http from 'http';
import https from 'https';
import fs from 'fs';
import url from 'url';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';
import { coreServices, withTableLock } from './services/core';
import { applyOpenAtLogin, isOpenAtLoginEnabled } from './services/hostRuntime';
import {
  dispatchTicket,
  pickActiveReceiptProfile,
  testPrintWithProfile,
} from './services/printDispatcher';
import {
  fiscalizePaymentOnce,
  flagVoidAfterFiscalization,
} from './services/fiscal';
import { reportAuditWriteFailure } from './services/adminAlerts';
import { stripTransferTagsFromNote } from '@shared/utils/transferNote';
import * as reservationsService from './services/reservations';
import {
  broadcastTicketsChanged,
  broadcastLayoutChanged,
} from './services/realtime';
import { readTableMerges, writeTableMerges } from './services/tableMerges';
import { transferTableLocal } from './services/tableTransfer';
import { setTableOpenWithSideEffects } from './services/tableOpen';
import { getTableTooltip, listPaidTablesForDay } from './services/tableTooltip';
import { createKdsTicketFromLog } from './services/kdsCreateTicket';
import { applyKdsVoidItem, applyKdsVoidTicket } from './services/kdsVoid';
import { ensureKdsLocalSchema } from './services/kdsSchema';
import { isClockOnlyRole } from '@shared/utils/roles';
import { authorizeLanRoute } from './services/lanPolicy';
import { logSecurityEvent } from './services/security';
import { sumTicketLinesNetVat } from '@shared/ticketRevenue';
import { enforceAuthoritativePaymentTotals } from './services/paymentTotals';
import { app } from 'electron';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import {
  formatKdsTicketListRows,
  getKdsTicketDetail,
} from './services/kdsList';
import {
  enabledStationsFromSettings,
  kdsMasterEnabledFromSettings,
} from './services/kdsStationRouting';
import {
  kdsStationListWhere,
  localDayStart,
  purgeKdsDoneTicketsForStation,
} from './services/kdsRetention';
import { getCurrentSessionOwnerId } from './services/tableSession';
import { finalizeShiftAfterClockOut } from './services/shiftSummary';
import {
  listMyActiveTickets,
  listMyPaidTickets,
  listMyVoidedTickets,
} from './services/staffReports';
import {
  recallKdsTicket,
  bumpAllStationItemsInJson,
} from './services/kdsRecall';
import {
  bumpReadyKitchenItems,
  cookerBumpAllKitchenItems,
  cookerBumpSingleKitchenItem,
  isTwoStageKitchen,
} from '@shared/kdsCooker';

/**
 * KITCHEN always runs the two-stage cook → pass (cooker) flow — it's the
 * product default and no longer configurable from the UI.
 */
async function getCookerEnabledFromSettings(): Promise<boolean> {
  return true;
}

async function maybeAlertSuspiciousVoidsLocal(input: {
  actorUserId: number;
  kind: 'VOID_ITEM' | 'VOID_TICKET';
}) {
  // Conservative thresholds to avoid false accusations.
  const windowMinutes = 60;
  const threshold = input.kind === 'VOID_TICKET' ? 3 : 6;
  const cooldownMinutes = 60;
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const prefix =
    input.kind === 'VOID_TICKET' ? 'Voided ticket on ' : 'Voided item on ';

  const count = await prisma.notification
    .count({
      where: {
        userId: input.actorUserId,
        type: 'OTHER' as any,
        createdAt: { gte: since } as any,
        message: { startsWith: prefix } as any,
      } as any,
    })
    .catch(() => 0);
  if (count < threshold) return;

  const actor = await prisma.user
    .findUnique({ where: { id: input.actorUserId } })
    .catch(() => null as any);
  const actorName = actor?.displayName
    ? String(actor.displayName)
    : `User #${input.actorUserId}`;

  const admins = await prisma.user
    .findMany({ where: { role: 'ADMIN', active: true } as any, take: 50 })
    .catch(() => []);

  const cooldownSince = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  const actionLabel =
    input.kind === 'VOID_TICKET' ? 'voided tickets' : 'voided items';
  const msg = `Unusual activity (auto-check): ${count} ${actionLabel} by ${actorName} in the last ${windowMinutes} minutes. This can be normal during corrections; please review if unexpected.`;

  for (const a of admins as any[]) {
    const already = await prisma.notification
      .count({
        where: {
          userId: a.id,
          type: 'SECURITY' as any,
          createdAt: { gte: cooldownSince } as any,
          message: { startsWith: 'Unusual activity (auto-check):' } as any,
        } as any,
      })
      .catch(() => 0);
    if (already > 0) continue;
    await prisma.notification
      .create({
        data: { userId: a.id, type: 'SECURITY' as any, message: msg } as any,
      })
      .catch(() => {});
  }
}

async function maybeAlertVoidSoonAfterPaymentLocal(input: {
  actorUserId: number;
  area: string;
  tableLabel: string;
  kind: 'VOID_ITEM' | 'VOID_TICKET';
}) {
  const windowMinutes = 10;
  const cooldownMinutes = 60;
  const now = Date.now();
  const cooldownSince = new Date(now - cooldownMinutes * 60 * 1000);
  const key = `${input.area}:${input.tableLabel}`;

  const row = await prisma.syncState
    .findUnique({ where: { key: 'antitheft:lastPaymentAt' } })
    .catch(() => null as any);
  const map = ((row?.valueJson as any) || {}) as Record<string, string>;
  const lastIso = map[key];
  if (!lastIso) return;
  const last = new Date(lastIso);
  const deltaMs = now - last.getTime();
  if (
    !Number.isFinite(deltaMs) ||
    deltaMs < 0 ||
    deltaMs > windowMinutes * 60 * 1000
  )
    return;

  const actor = await prisma.user
    .findUnique({ where: { id: input.actorUserId } })
    .catch(() => null as any);
  const actorName = actor?.displayName
    ? String(actor.displayName)
    : `User #${input.actorUserId}`;
  const admins = await prisma.user
    .findMany({ where: { role: 'ADMIN', active: true } as any, take: 50 })
    .catch(() => []);

  const minutesAgo = Math.max(0, Math.round(deltaMs / 60000));
  const actionLabel =
    input.kind === 'VOID_TICKET' ? 'voided a ticket' : 'voided an item';
  const msg =
    `Unusual activity (auto-check): ${actorName} ${actionLabel} on ${input.area} Table ${input.tableLabel} about ${minutesAgo} minutes after payment. ` +
    `This can be normal (corrections/reprints); please review if unexpected.`;

  for (const a of admins as any[]) {
    const already = await prisma.notification
      .count({
        where: {
          userId: a.id,
          type: 'SECURITY' as any,
          createdAt: { gte: cooldownSince } as any,
          message: { includes: 'minutes after payment' } as any,
        } as any,
      })
      .catch(() => 0);
    if (already > 0) continue;
    await prisma.notification
      .create({
        data: { userId: a.id, type: 'SECURITY' as any, message: msg } as any,
      })
      .catch(() => {});
  }
}

type CorsPolicy = {
  allowOrigin: (
    origin: string | undefined,
    hostHeader: string | undefined,
  ) => string | null;
};

type AuthContext = { userId: number; role?: string } | null;

// Suspicious-pattern detection (best-effort, in-memory).
const mgrPinFailByIp = new Map<
  string,
  { count: number; resetAt: number; lastAlertAt: number }
>();

// Suspicious-pattern detection (best-effort, in-memory) for payment adjustments.
const payAdjustByUser = new Map<
  number,
  {
    discountCount: number;
    serviceRemovalCount: number;
    resetAt: number;
    lastAlertAt: number;
  }
>();

function send(
  res: http.ServerResponse,
  code: number,
  data: any,
  corsOrigin?: string | null,
) {
  // Set security headers first
  setSecurityHeaders(res, corsOrigin || null);

  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const contentType =
    typeof data === 'string'
      ? 'text/plain; charset=utf-8'
      : 'application/json; charset=utf-8';

  // Override Content-Type (security headers function doesn't set it for flexibility)
  res.setHeader('Content-Type', contentType);

  res.writeHead(code);
  res.end(body);
}

// Hard cap on inbound JSON bodies to prevent OOM / DoS. 1 MB is plenty for
// every documented LAN-API payload; backups & menu uploads use dedicated streaming routes.
const MAX_JSON_BYTES = 1024 * 1024;

async function parseJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_JSON_BYTES) {
        aborted = true;
        const err = Object.assign(new Error('payload too large'), {
          statusCode: 413,
        });
        try {
          req.destroy();
        } catch {
          // ignore
        }
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function base64url(input: Buffer | string) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function hmacSha256(secret: string, input: string) {
  return crypto.createHmac('sha256', secret).update(input).digest();
}

async function getOrCreateApiSecret(): Promise<string> {
  const current = await coreServices.readSettings();
  const existing = (current as any)?.security?.apiSecret;
  if (typeof existing === 'string' && existing.length >= 32) return existing;
  const created = base64url(crypto.randomBytes(32));
  await coreServices.updateSettings({
    security: { ...(current as any)?.security, apiSecret: created },
  });
  return created;
}

async function getOrCreatePairingCode(): Promise<string> {
  const current = await coreServices.readSettings();
  const existing = (current as any)?.security?.pairingCode;
  if (typeof existing === 'string' && existing.trim().length >= 4)
    return existing.trim();
  // 6 digits
  const created = String(Math.floor(100000 + Math.random() * 900000));
  await coreServices.updateSettings({
    security: { ...(current as any)?.security, pairingCode: created },
  });
  return created;
}

function isLoopback(remoteAddress: string | undefined) {
  const ip = String(remoteAddress || '');
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  // IPv4 mapped IPv6
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * True when the request is coming from the native iOS/Android shell (the
 * Capacitor build sets `X-POS-Client: native` on every fetch, and adds
 * `?client=native` to the SSE URL because EventSource can't carry headers).
 * Browsers do not set this marker, so the LAN "Allow Web access" toggle
 * continues to gate them as before.
 *
 * The marker is a *hint*, not authentication — pairing-code and PIN login
 * are still required for the native app to actually do anything.
 */
function isNativeClient(
  req: http.IncomingMessage,
  parsed?: url.UrlWithParsedQuery,
) {
  const headerVal = req.headers['x-pos-client'];
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (String(header || '').toLowerCase() === 'native') return true;
  const query = parsed?.query?.client;
  const q = Array.isArray(query) ? query[0] : query;
  return String(q || '').toLowerCase() === 'native';
}

async function issueToken(
  secret: string,
  ctx: { userId: number; role?: string },
  ttlSeconds = 12 * 60 * 60,
) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      sub: ctx.userId,
      role: ctx.role,
      iat: now,
      exp: now + ttlSeconds,
    }),
  );
  const body = `${header}.${payload}`;
  const sig = base64url(hmacSha256(secret, body));
  return `${body}.${sig}`;
}

async function issueApprovalToken(
  secret: string,
  ctx: { userId: number; role?: string },
  ttlSeconds = 5 * 60,
) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      sub: ctx.userId,
      role: ctx.role,
      purpose: 'manager_approval',
      iat: now,
      exp: now + ttlSeconds,
    }),
  );
  const body = `${header}.${payload}`;
  const sig = base64url(hmacSha256(secret, body));
  return `${body}.${sig}`;
}

async function verifyApprovalToken(
  secret: string,
  token: string,
): Promise<AuthContext> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = base64url(hmacSha256(secret, `${h}.${p}`));
  if (s.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s)))
    return null;
  let payload: any;
  try {
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (String(payload?.purpose || '') !== 'manager_approval') return null;
  if (!payload?.sub || typeof payload.sub !== 'number') return null;
  if (typeof payload.exp === 'number' && payload.exp < now) return null;
  // Only admins can approve.
  if (String(payload.role || '').toUpperCase() !== 'ADMIN') return null;
  return { userId: payload.sub, role: payload.role };
}

async function verifyToken(
  secret: string,
  token: string,
): Promise<AuthContext> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = base64url(hmacSha256(secret, `${h}.${p}`));
  if (s.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s)))
    return null;
  let payload: any;
  try {
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const userId = Number(payload.sub);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  if (typeof payload.exp === 'number' && payload.exp < now) return null;
  return {
    userId,
    role: String(payload.role || '').toUpperCase(),
  };
}

function pickBearerToken(
  req: http.IncomingMessage,
  parsedUrl: url.UrlWithParsedQuery,
): string | null {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer '))
    return auth.slice(7).trim() || null;
  const q = (parsedUrl.query as any) || {};
  const t = typeof q.token === 'string' ? q.token : null;
  return t || null;
}

function createCorsPolicy(isDev: boolean): CorsPolicy {
  const extra = (process.env.POS_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dev = isDev
    ? [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        // Vite mobile dev server (vite.mobile.config.ts uses :5174 with host:true).
        'http://localhost:5174',
        'http://127.0.0.1:5174',
      ]
    : [];
  // Well-known Capacitor WebView origins. The waiter mobile app talks to the
  // POS LAN API from these origins; without them the WebView preflight fails
  // and every fetch silently errors out.
  //   iOS         → capacitor://localhost
  //   Android     → http://localhost (default) or https://localhost (when
  //                 androidScheme:'https' is set in capacitor.config.ts)
  //   Older Ionic → ionic://localhost
  const capacitorOrigins = [
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'https://localhost',
  ];
  const allowList = new Set<string>([...extra, ...dev, ...capacitorOrigins]);

  return {
    allowOrigin(origin: string | undefined, hostHeader: string | undefined) {
      if (!origin) return null; // non-browser / no CORS needed
      // Always allow same-host origins (e.g., renderer served from the API server itself)
      try {
        const o = new URL(origin);
        const host = (hostHeader || '').split(',')[0]?.trim() || '';
        const hostNoPort = host.includes(':') ? host.split(':')[0] : host;
        if (o.hostname === hostNoPort) return origin;
      } catch {
        // ignore
      }
      if (allowList.has(origin)) return origin;
      return null;
    },
  };
}

/**
 * Set security headers on HTTP responses
 */
function setSecurityHeaders(
  res: http.ServerResponse,
  corsOrigin: string | null,
): void {
  // Content Security Policy (CSP) - strict for API responses
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none';",
  );

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // XSS Protection (legacy, but still useful)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CORS headers (if origin is allowed)
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      // `X-POS-Client` is set by the Capacitor iOS/Android shell so the
      // backend can recognise the native app and bypass the browser-only
      // "Allow Web access" gate. The WebView's CORS preflight will refuse
      // to send the actual request unless this header is listed here.
      'Content-Type, Authorization, Idempotency-Key, X-POS-Client',
    );
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  }

  // HSTS (HTTP Strict Transport Security) - only for HTTPS
  if (process.env.HTTPS_ENABLED === 'true') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
}

/**
 * Where an operator installs the LAN HTTPS certificate.
 *
 * Deliberately outside the repo and outside the app bundle. A previous
 * build read `key.pem` from the working directory, and the key that
 * satisfied it had been committed to source control — so anyone with
 * repo access held the private key for every deployment.
 */
export function tlsCertDir(): string {
  try {
    return join(app.getPath('userData'), 'certs');
  } catch {
    // `app` is unavailable outside Electron (unit tests, tooling).
    return join(process.cwd(), 'certs');
  }
}

/**
 * Load the LAN HTTPS key pair, or `null` when none is installed.
 * A missing certificate is a normal, supported configuration.
 */
export function readTlsMaterial(): { key: Buffer; cert: Buffer } | null {
  const dir = tlsCertDir();
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch {
    return null;
  }
}

export async function startApiServer(httpPort = 3333, httpsPort = 3443) {
  const CURRENT_FILE = fileURLToPath(import.meta.url);
  const CURRENT_DIR = dirname(CURRENT_FILE);
  // When bundled, api runs from dist/main/chunks/* — renderer is at dist/renderer
  const RUNTIME_DIR =
    basename(CURRENT_DIR) === 'chunks' ? join(CURRENT_DIR, '..') : CURRENT_DIR;
  const RENDERER_DIR = join(RUNTIME_DIR, '../renderer');
  const RENDERER_ORIGIN =
    process.env.RENDERER_ORIGIN || process.env.ELECTRON_RENDERER_URL || '';
  // Native tablets must reach this process on the LAN even when "Allow Web
  // access" is off — that toggle only gates browsers.
  const bindHost = process.env.POS_BIND_HOST || '0.0.0.0';
  const secret = await getOrCreateApiSecret();
  const cors = createCorsPolicy(Boolean(process.env.ELECTRON_RENDERER_URL));

  function getContentType(pathname: string) {
    if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
    if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
    if (pathname.endsWith('.js'))
      return 'application/javascript; charset=utf-8';
    if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg'))
      return 'image/jpeg';
    if (pathname.endsWith('.woff2')) return 'font/woff2';
    if (pathname.endsWith('.map')) return 'application/octet-stream';
    return 'text/plain; charset=utf-8';
  }

  const handler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    try {
      const parsed = url.parse(req.url || '', true);
      const pathname = parsed.pathname || '';
      const origin =
        typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const corsOrigin = cors.allowOrigin(
        origin,
        typeof req.headers.host === 'string' ? req.headers.host : undefined,
      );

      if (req.method === 'OPTIONS') {
        // Only respond with CORS headers when origin is allowed.
        send(
          res,
          corsOrigin ? 200 : 403,
          corsOrigin ? 'ok' : 'forbidden',
          corsOrigin,
        );
        return;
      }

      // Live LAN gate: if web access is disabled, reject any non-loopback
      // requests immediately. This lets the admin toggle "Allow Web access"
      // on/off without restarting the app — the desktop app (loopback) is
      // always allowed, while *browsers* (tablets/phones/laptops on the LAN)
      // are blocked until the toggle is re-enabled.
      //
      // The native iOS/Android shell identifies itself with
      //   `X-POS-Client: native`
      // (or `?client=native` for SSE, which can't set custom headers via
      // EventSource). The toggle is a browser-only gate — the native app
      // still has its own pairing-code + login flow, so we let it through
      // regardless of the web-access setting. Treat the marker as a hint:
      // pairing / auth remain authoritative for who actually gets in.
      try {
        const remoteIp = String((req.socket as any)?.remoteAddress || '');
        if (!isLoopback(remoteIp) && !isNativeClient(req, parsed)) {
          const liveSettings = await coreServices.readSettings();
          const lanEnabledLive =
            Boolean((liveSettings as any)?.security?.allowLan) ||
            process.env.POS_ALLOW_LAN === 'true';
          if (!lanEnabledLive) {
            return send(res, 403, { error: 'web access disabled' }, corsOrigin);
          }
        }
      } catch {
        // If the settings read fails, fall through to default behavior.
      }

      // Active receipt-printer resolution is owned by the
      // `printDispatcher` module — see `pickActiveReceiptProfile()`.
      // Endpoints below call it directly; no helper needed here.

      const isStaticGet =
        req.method === 'GET' &&
        (pathname === '/' ||
          pathname === '/renderer' ||
          pathname === '/renderer/' ||
          pathname.startsWith('/renderer/') ||
          pathname === '/index.html' ||
          pathname.startsWith('/assets/') ||
          pathname.startsWith('/favicon'));

      // Static site (serve built renderer or proxy to remote origin)
      if (req.method === 'GET' && isStaticGet) {
        let filePath = '';
        if (
          pathname === '/' ||
          pathname === '/renderer' ||
          pathname === '/renderer/'
        ) {
          filePath = join(RENDERER_DIR, 'index.html');
        } else if (pathname.startsWith('/renderer/')) {
          filePath = join(RENDERER_DIR, pathname.replace('/renderer/', ''));
        } else if (
          pathname === '/index.html' ||
          pathname.startsWith('/assets/') ||
          pathname.startsWith('/favicon')
        ) {
          filePath = join(RENDERER_DIR, pathname.replace(/^\//, ''));
        }
        if (filePath) {
          // If proxy origin configured, fetch from it and stream through
          if (RENDERER_ORIGIN) {
            try {
              const upstreamPath =
                pathname === '/' ||
                pathname === '/renderer' ||
                pathname === '/renderer/'
                  ? '/'
                  : pathname.replace('/renderer/', '/');
              const upstreamUrl = new URL(
                upstreamPath,
                RENDERER_ORIGIN,
              ).toString();
              const upstream = await fetch(upstreamUrl);
              const buf = new Uint8Array(await upstream.arrayBuffer());
              const headers: Record<string, string> = {
                'Content-Type':
                  upstream.headers.get('content-type') ||
                  getContentType(upstreamPath),
              };
              if (corsOrigin)
                headers['Access-Control-Allow-Origin'] = corsOrigin;
              res.writeHead(upstream.status, headers);
              res.end(Buffer.from(buf));
              return;
            } catch {
              // fall back to local files
            }
          }
          try {
            if (
              !fs.existsSync(filePath) ||
              fs.statSync(filePath).isDirectory()
            ) {
              filePath = join(RENDERER_DIR, 'index.html');
            }
            const stream = fs.createReadStream(filePath);
            const headers: Record<string, string> = {
              'Content-Type': getContentType(filePath),
            };
            if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
            res.writeHead(200, headers);
            stream.pipe(res);
            return;
          } catch {
            // fall through
          }
        }
      }

      // Dev-mode proxy: forward Vite dev resource requests to the Vite dev server
      // (handles /@vite/client, /@react-refresh, /src/..., /node_modules/... etc.)
      const isViteDevResource =
        RENDERER_ORIGIN &&
        req.method === 'GET' &&
        !isStaticGet &&
        (pathname.startsWith('/@') ||
          pathname.startsWith('/node_modules/') ||
          pathname.startsWith('/src/') ||
          /\.(tsx?|jsx?|css|mjs|json|vue|svelte|wasm)(\?.*)?$/.test(pathname));
      if (isViteDevResource) {
        try {
          const upstreamUrl = new URL(
            pathname + (parsed.search || ''),
            RENDERER_ORIGIN,
          ).toString();
          const upstream = await fetch(upstreamUrl);
          const buf = new Uint8Array(await upstream.arrayBuffer());
          const ct =
            upstream.headers.get('content-type') || getContentType(pathname);
          const headers: Record<string, string> = { 'Content-Type': ct };
          if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
          res.writeHead(upstream.status, headers);
          res.end(Buffer.from(buf));
          return;
        } catch {
          return send(
            res,
            502,
            {
              error: 'vite_dev_unreachable',
              message:
                'Renderer dev server proxy failed — is Vite running? For tablets / LAN browsers use a production POS build so /renderer serves dist/renderer without Vite.',
            },
            corsOrigin,
          );
        }
      }

      // SSE events
      if (req.method === 'GET' && pathname === '/events') {
        const token = pickBearerToken(req, parsed);
        const auth = token ? await verifyToken(secret, token) : null;
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        // Set security headers for SSE (except CSP which interferes with SSE)
        setSecurityHeaders(res, corsOrigin || null);
        // Override CSP for SSE (it needs to connect)
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; connect-src 'self'",
        );
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.writeHead(200);
        res.write('\n');
        const client = { res } as any;
        (globalThis as any).__SSE_CLIENTS__ =
          (globalThis as any).__SSE_CLIENTS__ || new Set();
        const clients: Set<any> = (globalThis as any).__SSE_CLIENTS__;
        clients.add(client);
        req.on('close', () => clients.delete(client));
        return;
      }

      // Auth
      // Verify pairing code (used by tablets before login)
      if (req.method === 'POST' && pathname === '/pairing/verify') {
        const remoteIp = String(
          (req.socket as any)?.remoteAddress || 'unknown',
        );
        const { pairingCode } = await parseJson(req);
        try {
          const s = await coreServices.readSettings();
          const requirePairing = Boolean(
            (s as any)?.security?.requirePairingCode,
          );
          const lanEnabled =
            Boolean((s as any)?.security?.allowLan) ||
            process.env.POS_ALLOW_LAN === 'true';
          // Native app bypasses the browser-only "Allow Web access" gate.
          if (!lanEnabled && !isNativeClient(req, parsed))
            return send(
              res,
              403,
              { ok: false, error: 'lan disabled' },
              corsOrigin,
            );
          if (!requirePairing) return send(res, 200, { ok: true }, corsOrigin);
          if (isLoopback(remoteIp))
            return send(res, 200, { ok: true }, corsOrigin);
          const code = await getOrCreatePairingCode();
          if (String(pairingCode || '').trim() !== code)
            return send(
              res,
              403,
              { ok: false, error: 'pairing code required' },
              corsOrigin,
            );
          return send(res, 200, { ok: true }, corsOrigin);
        } catch {
          if (!isLoopback(remoteIp))
            return send(
              res,
              403,
              { ok: false, error: 'pairing code required' },
              corsOrigin,
            );
          return send(res, 200, { ok: true }, corsOrigin);
        }
      }
      if (req.method === 'POST' && pathname === '/auth/login') {
        // Login is intentionally not rate-limited. Waiter tablets retype PINs
        // throughout a shift and a 429 mid-service is worse than the
        // brute-force risk, which is already mitigated by the LAN pairing
        // code requirement (see /auth/pairing-check below).
        const { pin, userId, pairingCode } = await parseJson(req);
        // If this is a LAN client (not loopback) and pairing is required, enforce it.
        try {
          const s = await coreServices.readSettings();
          const requirePairing = Boolean(
            (s as any)?.security?.requirePairingCode,
          );
          const lanEnabled =
            Boolean((s as any)?.security?.allowLan) ||
            process.env.POS_ALLOW_LAN === 'true';
          // Native app bypasses the browser-only "Allow Web access" gate,
          // but the pairing-code check below still applies to it when
          // pairing is required.
          const gateForBrowsers = lanEnabled || isNativeClient(req, parsed);
          if (
            !gateForBrowsers &&
            !isLoopback((req.socket as any)?.remoteAddress)
          ) {
            return send(res, 403, { error: 'web access disabled' }, corsOrigin);
          }
          if (
            requirePairing &&
            !isLoopback((req.socket as any)?.remoteAddress)
          ) {
            const code = await getOrCreatePairingCode();
            if (String(pairingCode || '').trim() !== code) {
              return send(
                res,
                403,
                { error: 'pairing code required' },
                corsOrigin,
              );
            }
          }
        } catch {
          // fail closed for LAN clients if we can't read settings
          if (!isLoopback((req.socket as any)?.remoteAddress)) {
            return send(
              res,
              403,
              { error: 'pairing code required' },
              corsOrigin,
            );
          }
        }
        // Local auth
        const where: any = userId
          ? { id: Number(userId), active: true }
          : { active: true };
        const user = await prisma.user.findFirst({ where });
        if (!user) return send(res, 200, null, corsOrigin);
        const ok = await bcrypt.compare(String(pin || ''), user.pinHash);
        if (!ok) {
          await prisma.notification
            .create({
              data: {
                userId: user.id,
                type: 'SECURITY' as any,
                message: 'Wrong PIN attempt on your account',
              },
            })
            .catch(() => {});
          return send(res, 200, null, corsOrigin);
        }
        const token = await issueToken(secret, {
          userId: user.id,
          role: String(user.role || '').toUpperCase(),
        });
        return send(
          res,
          200,
          {
            user: {
              id: user.id,
              displayName: user.displayName,
              role: user.role,
              active: user.active,
              createdAt: user.createdAt.toISOString(),
            },
            token,
          },
          corsOrigin,
        );
      }
      if (req.method === 'GET' && pathname === '/auth/users') {
        // Local-first: always use local DB for users
        const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
        return send(
          res,
          200,
          users.map((u: any) => ({
            id: u.id,
            externalId: u.externalId ? String(u.externalId) : undefined,
            displayName: u.displayName,
            role: u.role,
            active: u.active,
            createdAt: u.createdAt.toISOString(),
          })),
          corsOrigin,
        );
      }

      // All non-public endpoints require a valid token when serving LAN clients.
      // (Electron renderer uses IPC and never hits this for privileged operations.)
      const publicPaths = new Set<string>([
        '/pairing/verify',
        '/auth/login',
        '/auth/users',
        '/menu/categories',
        // KDS should be usable on dedicated kitchen devices without login.
        '/kds/tickets',
        '/kds/ticket-detail',
        '/kds/bump',
        '/kds/bump-item',
        '/kds/recall',
        '/kds/clear-done',
        '/kds/cooker-mode',
        '/kds/enabled-stations',
        '/kds/debug',
        '/shifts/open',
        '/settings',
        '/offline/status',
        '/billing/status',
      ]);
      const isPublic = publicPaths.has(pathname) || isStaticGet;
      let auth: AuthContext = null;
      if (!isPublic) {
        const token = pickBearerToken(req, parsed);
        auth = token ? await verifyToken(secret, token) : null;
        if (!auth) {
          return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        }
      }

      // Positive authorization gate. Until this existed, a route was only as
      // protected as whatever `auth.role` check its own handler remembered to
      // make — and four privileged routes made none, so any logged-in tablet
      // could read business-wide revenue or rewrite printer and fiscal config.
      // The per-handler checks below are finer-grained (mostly "your own data
      // unless admin") and still apply; this runs first.
      {
        const verdict = authorizeLanRoute(
          req.method || 'GET',
          pathname,
          auth?.role,
        );
        if (verdict !== 'allow') {
          console.warn('[lan] denied', {
            method: req.method,
            pathname,
            verdict,
            role: auth?.role ?? null,
            userId: auth?.userId ?? null,
          });
          logSecurityEvent('lan_denied', {
            method: req.method,
            pathname,
            verdict,
            role: auth?.role ?? null,
            userId: auth?.userId ?? null,
          });
          // `unknown` means no policy exists for the route. Deny it: a route
          // nobody decided about should not be reachable from the network.
          const status = verdict === 'unauthenticated' ? 401 : 403;
          return send(
            res,
            status,
            { error: status === 401 ? 'unauthorized' : 'forbidden' },
            corsOrigin,
          );
        }
      }

      // Clock-only roles (KP/CHEF/HEAD_CHEF/HOST/...) are allowed to use ONLY
      // shift endpoints. This enforces "can only clock in/out" for LAN browser
      // clients. HOST is technically clock-only, but the reservation panel
      // legitimately needs the reservation endpoints (and also `/auth/users`
      // for the staff list and `/settings` for the area selector). We only
      // ever expose those to HOSTs because every reservation route still goes
      // through `assertHostOrAdmin` against the local DB.
      if (auth && isClockOnlyRole((auth as any).role)) {
        const role = String((auth as any).role || '').toUpperCase();
        const allowed = new Set<string>([
          '/shifts/open',
          '/shifts/get-open',
          '/shifts/clock-in',
          '/shifts/clock-out',
          '/shifts/public-open',
          // AppLayout fetches these on every shell, including /app/clock.
          '/billing/status',
          '/notifications',
          '/notifications/mark-all-read',
          '/layout/merges',
          '/reservations/merges',
          // HOST may read open POS tickets to paint the reservations floor.
          // POST /tables/open stays POS-only via authorizeLanRoute.
          '/tables/open',
          '/tickets/tooltip',
          '/tickets/paid-tables',
        ]);
        const isHostReservationsPath =
          (role === 'HOST' || role === 'ADMIN') &&
          (pathname === '/auth/users' ||
            pathname === '/settings' ||
            pathname === '/auth/verify-manager-pin' ||
            pathname === '/tables/open' ||
            pathname === '/tickets/tooltip' ||
            pathname === '/tickets/paid-tables' ||
            pathname.startsWith('/reservations') ||
            pathname.startsWith('/layout') ||
            pathname.startsWith('/notifications'));
        if (!allowed.has(pathname) && !isHostReservationsPath)
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
      }

      // Verify manager/admin PIN for approvals (requires staff to be logged in).
      if (req.method === 'POST' && pathname === '/auth/verify-manager-pin') {
        // For LAN host API, do not trust x-forwarded-for (clients can spoof it).
        const remoteIp = String(req.socket.remoteAddress || '').trim();
        const { pin } = await parseJson(req);
        const p = String(pin || '').trim();
        if (!/^\d{4,6}$/.test(p))
          return send(res, 200, { ok: false }, corsOrigin);
        // Track repeated failures per IP (conservative thresholds, neutral admin alert).
        const windowMinutes = 10;
        const threshold = 10;
        const cooldownMinutes = 60;
        const now = Date.now();
        const cur = mgrPinFailByIp.get(remoteIp);
        if (!cur || cur.resetAt <= now) {
          mgrPinFailByIp.set(remoteIp, {
            count: 0,
            resetAt: now + windowMinutes * 60 * 1000,
            lastAlertAt: cur?.lastAlertAt || 0,
          });
        }
        // Local-first: always use local DB for manager PIN verification
        const admins = await prisma.user
          .findMany({
            where: { role: 'ADMIN', active: true },
            orderBy: { id: 'asc' },
          })
          .catch(() => []);
        for (const u of admins as any[]) {
          const ok = await bcrypt
            .compare(p, String((u as any).pinHash || ''))
            .catch(() => false);
          if (ok) {
            // success resets counter
            const st = mgrPinFailByIp.get(remoteIp);
            if (st) mgrPinFailByIp.set(remoteIp, { ...st, count: 0 });
            const approvalToken = await issueApprovalToken(secret, {
              userId: (u as any).id,
              role: 'ADMIN',
            });
            return send(
              res,
              200,
              {
                ok: true,
                userId: (u as any).id,
                userName: (u as any).displayName,
                approvalToken,
              },
              corsOrigin,
            );
          }
        }
        // failure increments counter + maybe alert
        const st = mgrPinFailByIp.get(remoteIp)!;
        st.count += 1;
        mgrPinFailByIp.set(remoteIp, st);
        if (
          st.count >= threshold &&
          (!st.lastAlertAt ||
            now - st.lastAlertAt > cooldownMinutes * 60 * 1000)
        ) {
          const msg =
            `Unusual activity (auto-check): ${st.count} manager PIN verification failures in the last ${windowMinutes} minutes` +
            `${remoteIp ? ` from IP ${remoteIp}` : ''}. ` +
            `This can be normal (mistyped PINs); please review if unexpected.`;
          for (const a of admins as any[]) {
            await prisma.notification
              .create({
                data: {
                  userId: a.id,
                  type: 'SECURITY' as any,
                  message: msg,
                } as any,
              })
              .catch(() => {});
          }
          st.lastAlertAt = now;
          mgrPinFailByIp.set(remoteIp, st);
        }
        return send(res, 200, { ok: false }, corsOrigin);
      }

      // Menu
      if (req.method === 'GET' && pathname === '/menu/categories') {
        const cats = await prisma.category.findMany({
          where: { active: true },
          orderBy: { sortOrder: 'asc' },
          // Include inactive items too so admin can re-enable; waiters will render disabled items greyed out.
          include: { items: { orderBy: { name: 'asc' } } },
        });
        return send(
          res,
          200,
          cats.map((c: any) => ({
            id: c.id,
            name: c.name,
            sortOrder: c.sortOrder,
            active: c.active,
            color: (c as any)?.color ?? null,
            kdsStation: (c as any)?.kdsStation ?? null,
            items: c.items.map((i: any) => ({
              id: i.id,
              name: i.name,
              sku: i.sku,
              price: Number(i.price),
              vatRate: Number(i.vatRate),
              active: i.active,
              categoryId: i.categoryId,
              // Required by the renderer for kg-priced items (opens the
              // weight keypad) and for kitchen routing. Without these the
              // mobile / tablet client falls back to a flat add and to the
              // default station, which silently breaks both flows.
              isKg: Boolean(i.isKg),
              station: i.station || 'KITCHEN',
            })),
          })),
          corsOrigin,
        );
      }

      // Tickets
      if (req.method === 'POST' && pathname === '/tickets') {
        const body = await parseJson(req);
        const { userId, area, tableLabel, covers, items, note } = body;
        if (!userId || !area || !tableLabel)
          return send(
            res,
            400,
            { ok: false, error: 'invalid payload' },
            corsOrigin,
          );
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { ok: false, error: 'forbidden' }, corsOrigin);
        if (!Array.isArray(items) || items.length === 0)
          return send(
            res,
            400,
            { ok: false, error: 'invalid items' },
            corsOrigin,
          );

        const sanitizedArea = String(area).trim().slice(0, 50);
        const sanitizedTableLabel = String(tableLabel).trim().slice(0, 50);
        const sanitizedNote = note ? String(note).trim().slice(0, 500) : null;
        const sanitizedCovers =
          covers != null && Number.isFinite(Number(covers))
            ? Math.min(999, Math.max(1, Number(covers)))
            : null;
        const idempotencyKey = String(body?.idempotencyKey || '').trim();

        if (idempotencyKey) {
          const existing = await prisma.ticketLog
            .findFirst({ where: { idempotencyKey } as any })
            .catch(() => null);
          if (existing) {
            return send(res, 200, { ok: true }, corsOrigin);
          }
        }

        const result = await withTableLock(
          sanitizedArea,
          sanitizedTableLabel,
          async () => {
            const isOpen = await coreServices.isTableOpen(
              sanitizedArea,
              sanitizedTableLabel,
            );
            if (!isOpen) {
              return {
                ok: false as const,
                error: `Table ${sanitizedArea} ${sanitizedTableLabel} is closed`,
                code: 'TABLE_CLOSED',
              };
            }

            const ownerId = await getCurrentSessionOwnerId(
              sanitizedArea,
              sanitizedTableLabel,
            );
            if (ownerId !== null && ownerId !== Number(userId)) {
              const actor = await prisma.user
                .findUnique({ where: { id: Number(userId) } })
                .catch(() => null);
              const actorIsAdmin =
                actor &&
                String((actor as any).role || '').toUpperCase() === 'ADMIN';
              if (!actorIsAdmin) {
                const ownerName = await prisma.user
                  .findUnique({ where: { id: ownerId } })
                  .catch(() => null);
                return {
                  ok: false as const,
                  error: `Table is owned by ${ownerName?.displayName || `waiter #${ownerId}`}`,
                  code: 'TABLE_OWNED_BY_OTHER',
                };
              }
            }

            try {
              await prisma.ticketLog.create({
                data: {
                  userId: Number(userId),
                  area: sanitizedArea,
                  tableLabel: sanitizedTableLabel,
                  covers: sanitizedCovers,
                  itemsJson: items ?? [],
                  note: sanitizedNote,
                  ...(idempotencyKey ? { idempotencyKey } : {}),
                },
              });
            } catch (e: any) {
              if (e?.code === 'P2002' && idempotencyKey) {
                return { ok: true as const };
              }
              throw e;
            }
            return { ok: true as const };
          },
        );

        if (!result.ok) {
          return send(res, 409, result, corsOrigin);
        }

        // Best-effort: append to the open KDS ticket (same logic as IPC).
        try {
          const kdsFireItems = Array.isArray(body?.kdsFireItems)
            ? body.kdsFireItems
            : undefined;
          await createKdsTicketFromLog({
            userId: Number(userId),
            area: sanitizedArea,
            tableLabel: sanitizedTableLabel,
            items: items ?? [],
            fireItems: kdsFireItems,
            note: sanitizedNote,
          });
        } catch {
          // ignore
        }
        // Broadcast change so every client (Electron windows + LAN/mobile
        // tablets via SSE) refreshes the waiter badge / table metrics for
        // this table immediately, instead of waiting for the next poll.
        try {
          broadcastTicketsChanged({
            area: sanitizedArea,
            tableLabel: sanitizedTableLabel,
            userId: Number(userId),
          });
        } catch (e) {
          void e;
        }
        return send(res, 201, { ok: true }, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/tickets/latest') {
        const area = String(parsed.query.area || '');
        const tableLabel = String(parsed.query.table || '');
        if (!area || !tableLabel) return send(res, 400, 'invalid', corsOrigin);
        // Scope to the current open session — see the matching IPC
        // handler `tickets:getLatestForTable`. Without this scope the
        // mobile waiter view briefly shows the previous (paid-out)
        // session's items right after Send.
        const atRow = await prisma.syncState
          .findUnique({ where: { key: 'tables:openAt' } })
          .catch(() => null);
        const atMap = ((atRow?.valueJson as any) || {}) as Record<
          string,
          string
        >;
        const sinceIso = atMap[`${area}:${tableLabel}`];
        const sinceParsed = sinceIso ? new Date(sinceIso) : null;
        const since =
          sinceParsed && Number.isFinite(sinceParsed.getTime())
            ? sinceParsed
            : null;
        const where: any = { area, tableLabel };
        if (since) where.createdAt = { gte: since };
        const last = await prisma.ticketLog.findFirst({
          where,
          orderBy: { createdAt: 'desc' },
        });
        if (!last) return send(res, 200, null, corsOrigin);
        const items = ((last.itemsJson as any) || []) as any[];
        return send(
          res,
          200,
          {
            items,
            note: stripTransferTagsFromNote(last.note) || null,
            covers: last.covers ?? null,
            createdAt: last.createdAt.toISOString(),
            userId: last.userId,
          },
          corsOrigin,
        );
      }
      if (req.method === 'GET' && pathname === '/tickets/tooltip') {
        const area = String(parsed.query.area || '');
        const tableLabel = String(
          parsed.query.table || parsed.query.tableLabel || '',
        );
        if (!area || !tableLabel) return send(res, 400, 'invalid', corsOrigin);
        const tip = await getTableTooltip(area, tableLabel);
        return send(res, 200, tip, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/tickets/paid-tables') {
        const dateIso = String(parsed.query.dateIso || parsed.query.date || '');
        const paid = await listPaidTablesForDay(dateIso);
        return send(res, 200, paid, corsOrigin);
      }

      // KDS endpoints should be usable by dedicated kitchen devices without login.
      // (Bump attribution is optional and best-effort.)

      // KDS (LAN): list station tickets and bump
      if (req.method === 'GET' && pathname === '/kds/tickets') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const settings: any = await coreServices
          .readSettings()
          .catch(() => ({}));
        if (!kdsMasterEnabledFromSettings(settings)) {
          return send(res, 200, [], corsOrigin);
        }
        const station = String(
          (parsed.query.station as any) || 'KITCHEN',
        ).toUpperCase();
        const status = String(
          (parsed.query.status as any) || 'NEW',
        ).toUpperCase();
        const limit = Math.min(
          200,
          Math.max(1, Number((parsed.query.limit as any) || 100)),
        );
        const cooker = String(parsed.query.cooker ?? '') === '1';
        const cookerEnabled = await getCookerEnabledFromSettings();
        // The cooker screen always reads OPEN (NEW) tickets — its "Done" tab
        // shows cooked-but-not-picked-up lines that still live on open tickets.
        const cookerView = cooker && isTwoStageKitchen(station, cookerEnabled);
        const queryStatus = cookerView ? 'NEW' : status;
        const rows = await (prisma as any).kdsTicketStation.findMany({
          where: kdsStationListWhere(station, queryStatus),
          include: { ticket: { include: { order: true } } },
          orderBy:
            queryStatus === 'NEW'
              ? { ticket: { firedAt: 'asc' } }
              : { bumpedAt: 'desc' },
          take: limit,
        });
        const out = await formatKdsTicketListRows(rows, station, status, {
          cooker,
          cookerEnabled,
        });
        return send(res, 200, out, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/kds/ticket-detail') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const ticketId = Number((parsed.query.ticketId as any) || 0);
        if (!ticketId)
          return send(res, 400, { error: 'invalid ticketId' }, corsOrigin);
        const detail = await getKdsTicketDetail(ticketId);
        if (!detail) return send(res, 404, { error: 'not found' }, corsOrigin);
        return send(res, 200, detail, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/kds/bump') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const { station, ticketId, cooker } = await parseJson(req);
        const st = String(station || 'KITCHEN').toUpperCase();
        const id = Number(ticketId || 0);
        if (!id) return send(res, 400, { error: 'invalid' }, corsOrigin);
        const now = new Date();
        const bumpedAt = now.toISOString();
        const cookerEnabled = await getCookerEnabledFromSettings();
        const twoStage = isTwoStageKitchen(st, cookerEnabled);
        const ticket = await (prisma as any).kdsTicket
          .findUnique({ where: { id } })
          .catch(() => null);

        // Two-stage KITCHEN: cooker screen only flags `cookerBumped` (stage 1);
        // the main screen finalises just the cooked lines (stage 2).
        if (twoStage && ticket) {
          const itemsAll: any[] = Array.isArray(ticket.itemsJson)
            ? ticket.itemsJson
            : [];
          if (cooker) {
            await (prisma as any).kdsTicket.update({
              where: { id },
              data: {
                itemsJson: cookerBumpAllKitchenItems(itemsAll, bumpedAt),
              },
            });
            return send(res, 200, { ok: true }, corsOrigin);
          }
          const nextItems = bumpReadyKitchenItems(itemsAll, bumpedAt);
          await (prisma as any).kdsTicket.update({
            where: { id },
            data: { itemsJson: nextItems },
          });
          const remaining = nextItems.filter(
            (x: any) =>
              !x?.voided &&
              !x?.bumped &&
              String(x?.station || '').toUpperCase() === st,
          );
          if (remaining.length === 0) {
            await (prisma as any).kdsTicketStation.updateMany({
              where: { ticketId: id, station: st, status: 'NEW' },
              data: {
                status: 'DONE',
                bumpedAt: now,
                bumpedById: auth?.userId || null,
              },
            });
          }
          return send(res, 200, { ok: true }, corsOrigin);
        }

        if (ticket) {
          const itemsAll: any[] = Array.isArray(ticket.itemsJson)
            ? ticket.itemsJson
            : [];
          const nextItems = bumpAllStationItemsInJson(itemsAll, st, bumpedAt);
          await (prisma as any).kdsTicket.update({
            where: { id },
            data: { itemsJson: nextItems },
          });
        }
        const updated = await (prisma as any).kdsTicketStation.updateMany({
          where: { ticketId: id, station: st, status: 'NEW' },
          data: {
            status: 'DONE',
            bumpedAt: now,
            bumpedById: auth?.userId || null,
          },
        });
        return send(res, 200, { ok: Boolean(updated?.count) }, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/kds/recall') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const { station, ticketId, itemIdx } = await parseJson(req);
        const result = await recallKdsTicket(prisma, {
          station: String(station || 'KITCHEN'),
          ticketId,
          itemIdx,
        });
        return send(res, 200, result, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/kds/clear-done') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const { station } = await parseJson(req);
        const result = await purgeKdsDoneTicketsForStation(
          prisma,
          String(station || 'KITCHEN'),
        );
        return send(res, 200, result, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/kds/bump-item') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const { station, ticketId, itemIdx, cooker } = await parseJson(req);
        const st = String(station || 'KITCHEN').toUpperCase();
        const id = Number(ticketId || 0);
        const idx = Number(itemIdx ?? -1);
        if (!id || !Number.isFinite(idx) || idx < 0)
          return send(res, 400, { error: 'invalid' }, corsOrigin);
        const now = new Date();
        const cookerEnabled = await getCookerEnabledFromSettings();
        const twoStage = isTwoStageKitchen(st, cookerEnabled);
        const ticket = await (prisma as any).kdsTicket
          .findUnique({ where: { id } })
          .catch(() => null);
        if (!ticket) return send(res, 404, { error: 'not found' }, corsOrigin);
        const itemsAll: any[] = Array.isArray(ticket.itemsJson)
          ? ticket.itemsJson
          : [];
        if (idx >= itemsAll.length)
          return send(res, 400, { error: 'invalid' }, corsOrigin);
        const it = itemsAll[idx];
        if (!it || String(it?.station || '').toUpperCase() !== st)
          return send(res, 400, { error: 'invalid' }, corsOrigin);

        // Two-stage KITCHEN: cooker flags `cookerBumped`; main is blocked from
        // finalising a line the cook hasn't finished yet.
        if (twoStage && cooker) {
          if (!it?.voided && !it?.cookerBumped) {
            await (prisma as any).kdsTicket.update({
              where: { id },
              data: {
                itemsJson: cookerBumpSingleKitchenItem(
                  itemsAll,
                  idx,
                  now.toISOString(),
                ),
              },
            });
          }
          return send(res, 200, { ok: true }, corsOrigin);
        }
        if (twoStage && !cooker && !it?.voided && !it?.cookerBumped) {
          return send(res, 423, { ok: false, error: 'locked' }, corsOrigin);
        }

        if (!it?.voided && !it?.bumped) {
          const next = itemsAll.slice();
          next[idx] = { ...it, bumped: true, bumpedAt: now.toISOString() };
          await (prisma as any).kdsTicket.update({
            where: { id },
            data: { itemsJson: next },
          });
          const remaining = next.filter(
            (x: any) =>
              !x?.voided &&
              !x?.bumped &&
              String(x?.station || '').toUpperCase() === st,
          );
          if (remaining.length === 0) {
            await (prisma as any).kdsTicketStation.updateMany({
              where: { ticketId: id, station: st, status: 'NEW' },
              data: {
                status: 'DONE',
                bumpedAt: now,
                bumpedById: auth?.userId || null,
              },
            });
          }
        }
        return send(res, 200, { ok: true }, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/kds/cooker-mode') {
        const enabled = await getCookerEnabledFromSettings();
        return send(res, 200, { enabled }, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/kds/enabled-stations') {
        const settings: any = await coreServices
          .readSettings()
          .catch(() => ({}));
        return send(
          res,
          200,
          {
            enabled: kdsMasterEnabledFromSettings(settings),
            stations: Array.from(enabledStationsFromSettings(settings)),
          },
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/kds/cooker-mode') {
        const body = await parseJson(req);
        const enabled = Boolean(body?.enabled);
        try {
          await coreServices.updateSettings({
            kds: { cookerEnabled: enabled },
          } as any);
          return send(res, 200, { ok: true, enabled }, corsOrigin);
        } catch (e: any) {
          return send(
            res,
            500,
            { ok: false, error: e?.message || 'failed' },
            corsOrigin,
          );
        }
      }
      if (req.method === 'GET' && pathname === '/kds/debug') {
        const ok = await ensureKdsLocalSchema();
        const settings: any = await coreServices
          .readSettings()
          .catch(() => ({}));
        const counts: any = {
          ticketLog: await prisma.ticketLog.count().catch(() => 0),
        };
        if (ok) {
          counts.kdsOrders = await (prisma as any).kdsOrder
            .count()
            .catch(() => 0);
          counts.kdsTickets = await (prisma as any).kdsTicket
            .count()
            .catch(() => 0);
          counts.kdsStations = await (prisma as any).kdsTicketStation
            .count()
            .catch(() => 0);
        }
        return send(
          res,
          200,
          {
            app: 'code-orbit-pos',
            schemaReady: ok,
            counts,
            restaurantName:
              String(settings?.restaurantName || '').trim() || undefined,
          },
          corsOrigin,
        );
      }

      // Printing: test and ticket (for browser clients on LAN). All
      // printer dispatch + routing lives in `printDispatcher.ts`; this
      // route is just a thin HTTP shim around it.
      if (req.method === 'POST' && pathname === '/print/test') {
        const settings = await coreServices.readSettings();
        const profile = pickActiveReceiptProfile(settings as any);
        if (!profile)
          return send(
            res,
            400,
            { ok: false, error: 'No printer configured' },
            corsOrigin,
          );
        const r = await testPrintWithProfile(profile, settings as any);
        return send(
          res,
          r.ok ? 200 : 500,
          { ok: r.ok, error: r.error },
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/print/ticket') {
        const body = await parseJson(req);
        const printIdempotencyKey = String(body?.idempotencyKey ?? '').trim();
        // Mirrors the `tickets:print` IPC guard. Without it a tablet
        // replaying a queued payment after a Wi-Fi drop would print and
        // fiscalize the same receipt twice.
        if (printIdempotencyKey) {
          const existing = await prisma.printJob
            .findFirst({
              where: { idempotencyKey: printIdempotencyKey } as any,
            })
            .catch(() => null);
          if (existing) return send(res, 200, { ok: true }, corsOrigin);
        }
        const requested = {
          area: String(body?.area || ''),
          tableLabel: String(body?.tableLabel || ''),
          covers: body?.covers ?? null,
          items: Array.isArray(body?.items) ? body.items : [],
          note: body?.note ?? null,
          userName: body?.userName || undefined,
          meta: body?.meta ?? undefined,
        } as any;
        if (
          !requested.area ||
          !requested.tableLabel ||
          requested.items.length === 0
        )
          return send(
            res,
            400,
            { ok: false, error: 'invalid payload' },
            corsOrigin,
          );
        const settings = await coreServices.readSettings();

        // iOS/Android tablets and LAN browsers are separate devices that
        // may run a stale bundle or be tampered with, so the totals they
        // send are advisory. Recompute from the line items before this
        // becomes a receipt, an audit row, or a fiscal record.
        const enforcedTotals = await enforceAuthoritativePaymentTotals(
          requested,
          settings as any,
          'lan',
        );
        const payload = enforcedTotals.payload;

        // Track last payment time per table + payment adjustment alerts.
        // Run before printing so it works for all printer modes — and
        // even if the print itself fails (so we still detect anomalies).
        try {
          const meta: any = payload?.meta || {};
          const kind = String(meta?.kind || '').toUpperCase();
          if (kind === 'PAYMENT') {
            const k = `${payload.area}:${payload.tableLabel}`;
            const payRow = await prisma.syncState
              .findUnique({ where: { key: 'antitheft:lastPaymentAt' } })
              .catch(() => null as any);
            const map = ((payRow?.valueJson as any) || {}) as Record<
              string,
              string
            >;
            map[k] = new Date().toISOString();
            if (payRow?.key) {
              await prisma.syncState
                .update({
                  where: { key: 'antitheft:lastPaymentAt' },
                  data: { valueJson: map } as any,
                })
                .catch(() => null);
            } else {
              await prisma.syncState
                .create({
                  data: {
                    key: 'antitheft:lastPaymentAt',
                    valueJson: map,
                  } as any,
                })
                .catch(() => null);
            }

            // Suspicious-pattern alerting for payment adjustments (discounts / service charge removal).
            const userId = Number(meta?.userId || 0);
            const discountAmt = Number(meta?.discountAmount || 0);
            const scEnabled = Boolean(meta?.serviceChargeEnabled);
            const scApplied = Boolean(meta?.serviceChargeApplied);
            const scAmt = Number(meta?.serviceChargeAmount || 0);
            if (userId) {
              const windowMinutes = 60;
              const cooldownMinutes = 60;
              const now = Date.now();
              const cur = payAdjustByUser.get(userId);
              if (!cur || cur.resetAt <= now) {
                payAdjustByUser.set(userId, {
                  discountCount: 0,
                  serviceRemovalCount: 0,
                  resetAt: now + windowMinutes * 60 * 1000,
                  lastAlertAt: cur?.lastAlertAt || 0,
                });
              }
              const st = payAdjustByUser.get(userId)!;
              if (Number.isFinite(discountAmt) && discountAmt > 0)
                st.discountCount += 1;
              if (
                scEnabled &&
                !scApplied &&
                Number.isFinite(scAmt) &&
                scAmt > 0
              )
                st.serviceRemovalCount += 1;
              payAdjustByUser.set(userId, st);

              const actor = await prisma.user
                .findUnique({ where: { id: userId } })
                .catch(() => null as any);
              const actorName = actor?.displayName
                ? String(actor.displayName)
                : `User #${userId}`;
              const admins = await prisma.user
                .findMany({
                  where: { role: 'ADMIN', active: true } as any,
                  take: 50,
                })
                .catch(() => []);
              const canAlert =
                !st.lastAlertAt ||
                now - st.lastAlertAt > cooldownMinutes * 60 * 1000;

              if (canAlert && st.discountCount >= 5) {
                const msg =
                  `Unusual activity (auto-check): ${st.discountCount} discounted payments by ${actorName} in the last ${windowMinutes} minutes. ` +
                  `This can be normal during promotions; please review if unexpected.`;
                for (const a of admins as any[]) {
                  await prisma.notification
                    .create({
                      data: {
                        userId: a.id,
                        type: 'SECURITY' as any,
                        message: msg,
                      } as any,
                    })
                    .catch(() => {});
                }
                st.lastAlertAt = now;
                payAdjustByUser.set(userId, st);
              } else if (canAlert && st.serviceRemovalCount >= 3) {
                const msg =
                  `Unusual activity (auto-check): ${st.serviceRemovalCount} service charge removals by ${actorName} in the last ${windowMinutes} minutes. ` +
                  `This can be normal during corrections; please review if unexpected.`;
                for (const a of admins as any[]) {
                  await prisma.notification
                    .create({
                      data: {
                        userId: a.id,
                        type: 'SECURITY' as any,
                        message: msg,
                      } as any,
                    })
                    .catch(() => {});
                }
                st.lastAlertAt = now;
                payAdjustByUser.set(userId, st);
              }
            }
          }
        } catch {
          // ignore
        }

        let fiscalPayload = payload;
        const payKind = String(payload?.meta?.kind || '').toUpperCase();
        if (payKind === 'PAYMENT') {
          const outcome = await fiscalizePaymentOnce(payload, settings as any, {
            idempotencyKey: printIdempotencyKey || undefined,
          });
          if (outcome.kind === 'needs-review') {
            // Retrying could file a second invoice with the tax service.
            // `permanent` moves it to the tablet's failed-sync surface
            // instead of the retry loop; admins were already notified.
            return send(
              res,
              409,
              {
                ok: false,
                code: 'FISCAL_NEEDS_REVIEW',
                error: outcome.message,
                permanent: true,
              },
              corsOrigin,
            );
          }
          if (outcome.kind === 'rejected') {
            // Refused, and it will be refused identically next time. Same
            // treatment as a review case so the tablet stops retrying.
            return send(
              res,
              409,
              {
                ok: false,
                code: 'FISCAL_REJECTED',
                error: outcome.message,
                permanent: true,
              },
              corsOrigin,
            );
          }
          if (outcome.kind !== 'ok') {
            return send(
              res,
              502,
              {
                ok: false,
                code: 'FISCAL_FAILED',
                error: outcome.message,
                message: outcome.message,
              },
              corsOrigin,
            );
          }
          fiscalPayload = outcome.payload;
        }

        // Single dispatch: hands off mode selection, profile picking,
        // and ORDER/category routing to `printDispatcher`. Used to be
        // ~150 lines of mode branching here; moving it out also fixed
        // the iOS routing gap (this HTTP route now respects per-station
        // / per-category printer assignments, just like the Electron
        // path does).
        const r = await dispatchTicket(fiscalPayload, settings as any, {
          // iOS / web waiters get the same automatic retry safety net
          // as the Electron app (PR 3).
          persistRetryOnTransientFailure: true,
        });

        // Receipt-history / audit row, matching the Electron path. This
        // is also what makes `printIdempotencyKey` above effective, so a
        // tablet retry is recognised as already-processed.
        try {
          await prisma.printJob.create({
            data: {
              type: 'RECEIPT' as any,
              payloadJson: fiscalPayload,
              status: r.ok ? ('SENT' as any) : ('FAILED' as any),
              ...(printIdempotencyKey
                ? { idempotencyKey: printIdempotencyKey }
                : {}),
            } as any,
          });
        } catch (e: any) {
          // P2002 = a concurrent identical payment won the race; its row
          // is the audit record and this one is a duplicate.
          if (!(e?.code === 'P2002' && printIdempotencyKey)) {
            // Without this row the payment is absent from receipt history
            // and the shift summary, and if it was fiscalized the tax
            // service holds an invoice this POS cannot show.
            await reportAuditWriteFailure({
              area: String(body?.area || ''),
              tableLabel: String(body?.tableLabel || ''),
              actorUserId: Number(body?.meta?.userId || 0) || undefined,
              error: String(e?.message || e),
            });
          }
        }

        return send(
          res,
          r.ok ? 200 : 500,
          { ok: r.ok, error: r.firstError },
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/tickets/void-item') {
        const {
          userId,
          area,
          tableLabel,
          item,
          approvedByAdminId,
          approvedByAdminName,
          approvedByAdminToken,
        } = await parseJson(req);
        if (!userId || !area || !tableLabel || !item?.name)
          return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        // Enforce admin approval for voids if enabled.
        try {
          const settings: any = await coreServices
            .readSettings()
            .catch(() => null);
          const requireApproval =
            settings?.security?.approvals?.requireManagerPinForVoid !== false;
          if (requireApproval && (!auth || auth.role !== 'ADMIN')) {
            const aid =
              approvedByAdminId != null ? Number(approvedByAdminId) : 0;
            if (!aid)
              return send(
                res,
                403,
                { error: 'admin_approval_required' },
                corsOrigin,
              );
            const tok = String(approvedByAdminToken || '').trim();
            const approved = tok
              ? await verifyApprovalToken(secret, tok)
              : null;
            if (
              !approved ||
              approved.userId !== aid ||
              String((approved as any).role || '').toUpperCase() !== 'ADMIN'
            )
              return send(
                res,
                403,
                { error: 'admin_approval_required' },
                corsOrigin,
              );
            const approver = await prisma.user
              .findUnique({ where: { id: aid } })
              .catch(() => null);
            const ok =
              approver &&
              (approver as any).active !== false &&
              String((approver as any).role || '').toUpperCase() === 'ADMIN';
            if (!ok)
              return send(
                res,
                403,
                { error: 'admin_approval_required' },
                corsOrigin,
              );
          }
        } catch {
          return send(
            res,
            403,
            { error: 'admin_approval_required' },
            corsOrigin,
          );
        }

        const message = `Voided item on ${area} ${tableLabel}: ${item.name} x${Number(item.qty || 1)}${approvedByAdminId ? ` (approved by: ${String(approvedByAdminName || `admin#${approvedByAdminId}`)})` : ''}`;
        await prisma.notification
          .create({
            data: { userId: Number(userId), type: 'OTHER' as any, message },
          })
          .catch(() => {});
        const last = await prisma.ticketLog.findFirst({
          where: { area, tableLabel },
          orderBy: { createdAt: 'desc' },
        });
        if (last) {
          const items = (last.itemsJson as any[]) || [];
          const idx = items.findIndex(
            (it: any) => it.name === item.name && !it?.voided,
          );
          if (idx !== -1) {
            items[idx] = { ...items[idx], voided: true };
            await prisma.ticketLog.update({
              where: { id: last.id },
              data: { itemsJson: items },
            });
          }
        }
        await applyKdsVoidItem({
          userId: Number(userId),
          area: String(area),
          tableLabel: String(tableLabel),
          item,
        }).catch(() => false);
        try {
          broadcastTicketsChanged({
            area: String(area),
            tableLabel: String(tableLabel),
            userId: Number(userId),
          });
        } catch {
          // best-effort
        }
        // Best-effort suspicious-pattern alerting (admins only; conservative thresholds).
        void maybeAlertSuspiciousVoidsLocal({
          actorUserId: Number(userId),
          kind: 'VOID_ITEM',
        });
        void maybeAlertVoidSoonAfterPaymentLocal({
          actorUserId: Number(userId),
          area: String(area),
          tableLabel: String(tableLabel),
          kind: 'VOID_ITEM',
        });
        await flagVoidAfterFiscalization({
          area: String(area),
          tableLabel: String(tableLabel),
          reason: `"${String(item?.name || 'Item')}" was voided after the sale was fiscalized`,
          actorUserId: Number(userId) || undefined,
        }).catch(() => false);
        return send(res, 200, 'ok', corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/tickets/void-ticket') {
        const {
          userId,
          area,
          tableLabel,
          reason,
          approvedByAdminId,
          approvedByAdminName,
          approvedByAdminToken,
        } = await parseJson(req);
        if (!userId || !area || !tableLabel)
          return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        // Enforce admin approval for voids if enabled.
        try {
          const settings: any = await coreServices
            .readSettings()
            .catch(() => null);
          const requireApproval =
            settings?.security?.approvals?.requireManagerPinForVoid !== false;
          if (requireApproval && (!auth || auth.role !== 'ADMIN')) {
            const aid =
              approvedByAdminId != null ? Number(approvedByAdminId) : 0;
            if (!aid)
              return send(
                res,
                403,
                { error: 'admin_approval_required' },
                corsOrigin,
              );
            const tok = String(approvedByAdminToken || '').trim();
            const approved = tok
              ? await verifyApprovalToken(secret, tok)
              : null;
            if (
              !approved ||
              approved.userId !== aid ||
              String((approved as any).role || '').toUpperCase() !== 'ADMIN'
            )
              return send(
                res,
                403,
                { error: 'admin_approval_required' },
                corsOrigin,
              );
            const approver = await prisma.user
              .findUnique({ where: { id: aid } })
              .catch(() => null);
            const ok =
              approver &&
              (approver as any).active !== false &&
              String((approver as any).role || '').toUpperCase() === 'ADMIN';
            if (!ok)
              return send(
                res,
                403,
                { error: 'admin_approval_required' },
                corsOrigin,
              );
          }
        } catch {
          return send(
            res,
            403,
            { error: 'admin_approval_required' },
            corsOrigin,
          );
        }

        const message = `Voided ticket on ${area} ${tableLabel}${reason ? `: ${reason}` : ''}${approvedByAdminId ? ` (approved by: ${String(approvedByAdminName || `admin#${approvedByAdminId}`)})` : ''}`;
        await prisma.notification
          .create({
            data: { userId: Number(userId), type: 'OTHER' as any, message },
          })
          .catch(() => {});
        const last = await prisma.ticketLog.findFirst({
          where: { area, tableLabel },
          orderBy: { createdAt: 'desc' },
        });
        if (last) {
          const items = ((last.itemsJson as any[]) || []).map((it: any) => ({
            ...it,
            voided: true,
          }));
          await prisma.ticketLog.update({
            where: { id: last.id },
            data: {
              itemsJson: items,
              note: last.note
                ? `${last.note} | VOIDED${reason ? `: ${reason}` : ''}`
                : `VOIDED${reason ? `: ${reason}` : ''}`,
            },
          });
        }
        // Must run before the close clears `tables:openAt`. Mirrors the
        // desktop `tickets:voidTicket` path: an invoice already filed for
        // this table needs a corrective document, not a silent close.
        await flagVoidAfterFiscalization({
          area: String(area),
          tableLabel: String(tableLabel),
          reason: `Ticket voided after the sale was fiscalized${reason ? `: ${String(reason)}` : ''}`,
          actorUserId: Number(userId) || undefined,
        }).catch(() => false);
        await setTableOpenWithSideEffects(
          String(area),
          String(tableLabel),
          false,
        ).catch(() => false);
        await applyKdsVoidTicket({
          userId: Number(userId),
          area: String(area),
          tableLabel: String(tableLabel),
          reason: reason ? String(reason) : undefined,
        }).catch(() => false);
        try {
          broadcastTicketsChanged({
            area: String(area),
            tableLabel: String(tableLabel),
            userId: Number(userId),
          });
        } catch {
          // best-effort
        }
        // Best-effort suspicious-pattern alerting (admins only; conservative thresholds).
        void maybeAlertSuspiciousVoidsLocal({
          actorUserId: Number(userId),
          kind: 'VOID_TICKET',
        });
        void maybeAlertVoidSoonAfterPaymentLocal({
          actorUserId: Number(userId),
          area: String(area),
          tableLabel: String(tableLabel),
          kind: 'VOID_TICKET',
        });
        return send(res, 200, 'ok', corsOrigin);
      }

      // Requests (owner flow) for browser clients
      if (req.method === 'POST' && pathname === '/requests/create') {
        const input = await parseJson(req);
        const { requesterId, ownerId, area, tableLabel, items, note } =
          input || {};
        if (
          !requesterId ||
          !ownerId ||
          !area ||
          !tableLabel ||
          !Array.isArray(items)
        )
          return send(res, 400, 'invalid', corsOrigin);
        if (
          auth &&
          Number(requesterId) !== auth.userId &&
          auth.role !== 'ADMIN'
        )
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        await prisma.ticketRequest.create({
          data: {
            requesterId: Number(requesterId),
            ownerId: Number(ownerId),
            area: String(area),
            tableLabel: String(tableLabel),
            itemsJson: items,
            note: note ? String(note) : null,
            status: 'PENDING' as any,
          },
        });
        return send(res, 200, 'ok', corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/requests/list-for-owner') {
        const ownerId = Number(parsed.query.ownerId || 0);
        if (!ownerId) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(ownerId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const rows = await prisma.ticketRequest.findMany({
          where: { ownerId, status: 'PENDING' as any },
          orderBy: { createdAt: 'desc' },
        } as any);
        return send(
          res,
          200,
          rows.map((r: any) => ({
            id: r.id,
            area: r.area,
            tableLabel: r.tableLabel,
            requesterId: r.requesterId,
            items: r.itemsJson,
            note: r.note,
            createdAt: r.createdAt.toISOString(),
          })),
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/requests/approve') {
        const { id, ownerId } = await parseJson(req);
        if (!id || !ownerId) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(ownerId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        await prisma.ticketRequest.updateMany({
          where: {
            id: Number(id),
            ownerId: Number(ownerId),
            status: 'PENDING' as any,
          },
          data: { status: 'APPROVED' as any, decidedAt: new Date() },
        });
        return send(res, 200, true, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/requests/reject') {
        const { id, ownerId } = await parseJson(req);
        if (!id || !ownerId) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(ownerId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        await prisma.ticketRequest.updateMany({
          where: {
            id: Number(id),
            ownerId: Number(ownerId),
            status: 'PENDING' as any,
          },
          data: { status: 'REJECTED' as any, decidedAt: new Date() },
        });
        return send(res, 200, true, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/requests/poll-approved') {
        const ownerId = Number(parsed.query.ownerId || 0);
        const area = String(parsed.query.area || '');
        const tableLabel = String(parsed.query.tableLabel || '');
        if (!ownerId || !area || !tableLabel)
          return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(ownerId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const rows = await prisma.ticketRequest.findMany({
          where: { ownerId, area, tableLabel, status: 'APPROVED' as any },
          orderBy: { createdAt: 'asc' },
        } as any);
        return send(
          res,
          200,
          rows.map((r: any) => ({
            id: r.id,
            items: r.itemsJson,
            note: r.note,
          })),
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/requests/mark-applied') {
        const body = await parseJson(req);
        const ids = Array.isArray(body?.ids)
          ? body.ids.map((x: any) => Number(x))
          : [];
        if (!ids.length) return send(res, 400, 'invalid', corsOrigin);
        await prisma.ticketRequest.updateMany({
          where: { id: { in: ids } },
          data: { status: 'APPLIED' as any },
        });
        return send(res, 200, true, corsOrigin);
      }

      // Tables open
      if (req.method === 'POST' && pathname === '/tables/open') {
        const { area, label, open } = await parseJson(req);
        if (!area || !label) return send(res, 400, 'invalid', corsOrigin);
        const ok = await setTableOpenWithSideEffects(
          String(area),
          String(label),
          Boolean(open),
        );
        if (!ok) return send(res, 400, 'invalid', corsOrigin);
        return send(res, 200, 'ok', corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/tables/open') {
        const key = 'tables:open';
        const row = await prisma.syncState.findUnique({ where: { key } });
        const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
        return send(
          res,
          200,
          Object.entries(map)
            .filter(([, v]) => Boolean(v))
            .map(([k]) => {
              const [area, label] = k.split(':');
              return { area, label };
            }),
          corsOrigin,
        );
      }

      // Table transfer (move table and/or ownership transfer)
      if (req.method === 'POST' && pathname === '/tables/transfer') {
        const body = await parseJson(req);
        const fromArea = String(body?.fromArea || '');
        const fromLabel = String(body?.fromLabel || '');
        const toArea = body?.toArea != null ? String(body.toArea) : null;
        const toLabel = body?.toLabel != null ? String(body.toLabel) : null;
        const toUserId = body?.toUserId != null ? Number(body.toUserId) : null;

        // Auth: if present, use it; otherwise fall back to explicit actorUserId (local setups).
        const actorUserId = auth?.userId
          ? Number(auth.userId)
          : Number(body?.actorUserId || 0);
        if (!fromArea || !fromLabel || !actorUserId)
          return send(res, 400, { ok: false, error: 'invalid' }, corsOrigin);

        // If auth exists and caller is not admin, actor is always the auth user.
        if (
          auth &&
          auth.role !== 'ADMIN' &&
          Number(actorUserId) !== Number(auth.userId)
        ) {
          return send(res, 403, { ok: false, error: 'forbidden' }, corsOrigin);
        }

        const r = await transferTableLocal({
          fromArea,
          fromLabel,
          toArea,
          toLabel,
          toUserId,
          actorUserId,
          actorRole: auth?.role,
          idempotencyKey:
            String(body?.idempotencyKey ?? '').trim() || undefined,
        } as any).catch((e: any) => ({
          ok: false as const,
          error: String(e?.message || e || 'Transfer failed'),
        }));
        return send(res, 200, r, corsOrigin);
      }

      // Layout: get/save for browser clients.
      //
      // Floor layouts are now centrally managed by the admin and shared
      // across every waiter / host device. The key is `layout:global:<area>`.
      // Legacy per-user / per-scope rows are still consulted as a one-time
      // migration fallback so existing layouts surface in the editor.
      const globalLayoutKey = (area: string) => `layout:global:${String(area)}`;
      if (req.method === 'GET' && pathname === '/layout/get') {
        const area = String(parsed.query.area || '');
        if (!area) return send(res, 400, 'invalid', corsOrigin);
        const globalRow = await prisma.syncState
          .findUnique({ where: { key: globalLayoutKey(area) } })
          .catch(() => null);
        const globalNodes = (globalRow?.valueJson as any)?.nodes;
        if (Array.isArray(globalNodes)) {
          return send(res, 200, globalNodes, corsOrigin);
        }
        // Migration fallback: scan legacy keys ending in `:<area>` and
        // return the most recent one so the new shared view still has
        // tables before the admin saves the first centralised layout.
        const candidates = await prisma.syncState
          .findMany({
            where: { key: { startsWith: 'layout:' } as any } as any,
            orderBy: { updatedAt: 'desc' } as any,
          })
          .catch(() => [] as any[]);
        const suffix = `:${area}`;
        for (const row of candidates as any[]) {
          if (typeof row?.key !== 'string') continue;
          if (row.key === globalLayoutKey(area)) continue;
          if (!row.key.endsWith(suffix)) continue;
          const nodes = (row?.valueJson as any)?.nodes;
          if (Array.isArray(nodes) && nodes.length) {
            return send(res, 200, nodes, corsOrigin);
          }
        }
        return send(res, 200, null, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/layout/save') {
        const { area, nodes } = await parseJson(req);
        if (!area || !Array.isArray(nodes))
          return send(res, 400, 'invalid', corsOrigin);
        // Only admins may rewrite the shared floor layout. Bearer-auth is
        // enforced higher up the stack; we just verify the role here.
        if (auth && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        await prisma.syncState.upsert({
          where: { key: globalLayoutKey(String(area)) },
          create: {
            key: globalLayoutKey(String(area)),
            valueJson: { nodes },
          },
          update: { valueJson: { nodes } },
        });
        try {
          broadcastLayoutChanged({ area: String(area) });
        } catch {
          // best-effort
        }
        return send(res, 200, 'ok', corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/layout/merges') {
        const area = String(parsed.query.area || '');
        if (!area) return send(res, 400, 'invalid', corsOrigin);
        const groups = await readTableMerges(area);
        return send(res, 200, groups, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/layout/merges') {
        const { area, groups } = await parseJson(req);
        if (!area) return send(res, 400, 'invalid', corsOrigin);
        const next = await writeTableMerges(String(area), groups);
        return send(res, 200, next, corsOrigin);
      }

      // Shifts (open userIds) - Local-first: always use local DB
      if (req.method === 'GET' && pathname === '/shifts/open') {
        const rows = await prisma.dayShift.findMany({
          where: { closedAt: null },
        });
        return send(
          res,
          200,
          rows.map((s: any) => s.openedById),
          corsOrigin,
        );
      }

      // Shift: get open shift for a user
      if (req.method === 'GET' && pathname === '/shifts/get-open') {
        const userId = Number(parsed.query.userId || 0);
        if (!userId) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const open = await prisma.dayShift.findFirst({
          where: { closedAt: null, openedById: userId },
        });
        return send(
          res,
          200,
          open
            ? {
                id: open.id,
                openedAt: open.openedAt.toISOString(),
                closedAt: open.closedAt
                  ? new Date(open.closedAt).toISOString()
                  : null,
                openedById: open.openedById,
                closedById: open.closedById ?? null,
              }
            : null,
          corsOrigin,
        );
      }
      // Shift: clock in
      if (req.method === 'POST' && pathname === '/shifts/clock-in') {
        const { userId } = await parseJson(req);
        if (!userId) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const already = await prisma.dayShift.findFirst({
          where: { closedAt: null, openedById: Number(userId) },
        });
        if (already)
          return send(
            res,
            200,
            {
              id: already.id,
              openedAt: already.openedAt.toISOString(),
              closedAt: null,
              openedById: already.openedById,
              closedById: already.closedById ?? null,
            },
            corsOrigin,
          );
        const created = await prisma.dayShift.create({
          data: { openedById: Number(userId), totalsJson: {} as any } as any,
        });
        return send(
          res,
          200,
          {
            id: created.id,
            openedAt: created.openedAt.toISOString(),
            closedAt: null,
            openedById: created.openedById,
            closedById: created.closedById ?? null,
          },
          corsOrigin,
        );
      }
      // Shift: clock out
      if (req.method === 'POST' && pathname === '/shifts/clock-out') {
        const body = await parseJson(req);
        const { userId } = body || {};
        const force = Boolean(body?.force);
        if (!userId) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const open = await prisma.dayShift.findFirst({
          where: { closedAt: null, openedById: Number(userId) },
        });
        if (!open) return send(res, 200, null, corsOrigin);

        // Mirror the IPC guard: refuse to clock out while the waiter
        // still owns open tables. Mobile waiters hit this same path, so
        // the same anti-stranding rule must apply or iOS becomes the
        // back door around it.
        if (!force) {
          const openTables: Array<{ area: string; label: string }> = [];
          try {
            const openRow = await prisma.syncState
              .findUnique({ where: { key: 'tables:open' } })
              .catch(() => null);
            const openMap = ((openRow?.valueJson as any) || {}) as Record<
              string,
              boolean
            >;
            const keys = Object.entries(openMap)
              .filter(([, v]) => Boolean(v))
              .map(([k]) => k);
            for (const key of keys) {
              const idx = key.indexOf(':');
              if (idx <= 0) continue;
              const area = key.slice(0, idx);
              const label = key.slice(idx + 1);
              const last = await prisma.ticketLog
                .findFirst({
                  where: { area, tableLabel: label },
                  orderBy: { createdAt: 'desc' },
                  select: { userId: true },
                })
                .catch(() => null);
              if (last && Number(last.userId) === Number(userId)) {
                openTables.push({ area, label });
              }
            }
          } catch {
            // Best-effort guard — never trap a waiter at work because
            // of a transient lookup failure.
          }
          if (openTables.length > 0) {
            return send(
              res,
              200,
              {
                ok: false,
                error: `You still have ${openTables.length} open table${openTables.length === 1 ? '' : 's'}. Close or transfer them before clocking out.`,
                code: 'OPEN_TABLES_OWNED',
                openTables,
              },
              corsOrigin,
            );
          }
        }

        const closedAt = new Date();
        const updated = await prisma.dayShift.update({
          where: { id: open.id },
          data: { closedAt, closedById: Number(userId) },
        });
        void finalizeShiftAfterClockOut({
          shiftId: updated.id,
          userId: Number(userId),
          openedAt: open.openedAt,
          closedAt,
        }).catch((e) =>
          console.warn('[api shifts/clock-out] shift print failed:', e),
        );
        return send(
          res,
          200,
          {
            id: updated.id,
            openedAt: updated.openedAt.toISOString(),
            closedAt: updated.closedAt
              ? new Date(updated.closedAt).toISOString()
              : null,
            openedById: updated.openedById,
            closedById: updated.closedById ?? null,
          },
          corsOrigin,
        );
      }

      // Billing status: tablets poll this after login. Host license is
      // enforced by not starting this API until the till is licensed.
      if (req.method === 'GET' && pathname === '/billing/status') {
        return send(
          res,
          200,
          { status: 'ACTIVE', billingEnabled: false },
          corsOrigin,
        );
      }
      if (
        req.method === 'POST' &&
        pathname === '/admin/billing/create-checkout'
      ) {
        return send(
          res,
          200,
          { error: 'Billing is managed from the desktop Admin window' },
          corsOrigin,
        );
      }
      if (
        req.method === 'POST' &&
        pathname === '/admin/billing/create-portal'
      ) {
        return send(
          res,
          200,
          { error: 'Billing is managed from the desktop Admin window' },
          corsOrigin,
        );
      }

      // Notifications for the signed-in staff member (tablet header bell).
      if (req.method === 'GET' && pathname === '/notifications') {
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        const onlyUnread = String(parsed.query.onlyUnread || '') === '1';
        const limit = Math.min(
          500,
          Math.max(1, Number(parsed.query.limit || 100) || 100),
        );
        const rows = await prisma.notification.findMany({
          where: {
            userId: auth.userId,
            ...(onlyUnread ? { readAt: null } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        } as any);
        return send(
          res,
          200,
          rows.map((n: any) => ({
            id: n.id,
            type: n.type,
            message: n.message,
            readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
            createdAt: new Date(n.createdAt).toISOString(),
          })),
          corsOrigin,
        );
      }
      if (
        req.method === 'POST' &&
        pathname === '/notifications/mark-all-read'
      ) {
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        await prisma.notification.updateMany({
          where: { userId: auth.userId, readAt: null },
          data: { readAt: new Date() },
        });
        return send(res, 200, { ok: true }, corsOrigin);
      }

      // Settings: get and update (for browser clients)
      if (req.method === 'GET' && pathname === '/settings') {
        const base = await coreServices.readSettings();
        // Enrich with table areas from DB so mobile/browser clients see the
        // same areas as the Electron app (which augments via main/index.ts).
        const dbAreas = await prisma.area
          .findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } })
          .catch(() => [] as any[]);
        const tableAreas = (dbAreas as any[]).length
          ? (dbAreas as any[]).map((a) => ({
              name: a.name,
              count: a.defaultCount,
            }))
          : ((base as any).tableAreas ?? []);
        const result = {
          ...base,
          tableAreas,
          printer: {
            ip: base.printer?.ip || null,
            port: Number(base.printer?.port || 9100),
          },
        } as any;
        if (result?.security && typeof result.security === 'object') {
          result.security = { ...result.security };
          delete result.security.apiSecret;
          // The pairing code is the gate that decides which LAN devices may
          // log in at all, and this route is reachable without a token — so
          // returning it here handed the key to anyone who could reach the
          // port. Clients only need to know *whether* a code is required.
          delete result.security.pairingCode;
        }
        if (result?.fiscal && typeof result.fiscal === 'object') {
          result.fiscal = { ...result.fiscal };
          if (result.fiscal.authToken) {
            result.fiscal.authTokenConfigured = true;
            delete result.fiscal.authToken;
          }
        }
        return send(res, 200, result, corsOrigin);
      }
      // Offline outbox status (for tablets / browser clients)
      if (req.method === 'GET' && pathname === '/offline/status') {
        const queued = await prisma.printJob
          .count({
            where: { status: { in: ['RETRY', 'QUEUED'] as any } },
          })
          .catch(() => 0);
        return send(res, 200, { queued }, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/settings/update') {
        try {
          const input = await parseJson(req);
          const merged = await coreServices.updateSettings(input);
          if (
            input?.host &&
            Object.prototype.hasOwnProperty.call(input.host, 'openAtLogin')
          ) {
            applyOpenAtLogin(isOpenAtLoginEnabled(merged));
          }
          const result = { ...(merged as any) };
          if (result?.fiscal && typeof result.fiscal === 'object') {
            result.fiscal = { ...result.fiscal };
            if (result.fiscal.authToken) {
              result.fiscal.authTokenConfigured = true;
              delete result.fiscal.authToken;
            }
          }
          return send(res, 200, result, corsOrigin);
        } catch (e) {
          void e;
          return send(
            res,
            500,
            { error: 'failed to update settings' },
            corsOrigin,
          );
        }
      }

      // Covers
      if (req.method === 'POST' && pathname === '/covers/save') {
        const { area, label, covers } = await parseJson(req);
        const num = Number(covers);
        if (!area || !label || !Number.isFinite(num) || num <= 0)
          return send(res, 400, 'invalid', corsOrigin);
        await prisma.covers.create({
          data: { area: String(area), label: String(label), covers: num },
        });
        return send(res, 200, 'ok', corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/covers/last') {
        const area = String(parsed.query.area || '');
        const label = String(parsed.query.label || '');
        if (!area || !label) return send(res, 400, 'invalid', corsOrigin);
        const openAtRow = await prisma.syncState
          .findUnique({ where: { key: 'tables:openAt' } })
          .catch(() => null);
        const openAtMap = ((openAtRow?.valueJson as any) || {}) as Record<
          string,
          string
        >;
        const sinceIso = openAtMap[`${area}:${label}`];
        const sinceParsed = sinceIso ? new Date(sinceIso) : null;
        const sessionStart =
          sinceParsed && Number.isFinite(sinceParsed.getTime())
            ? sinceParsed
            : null;
        const where: any = { area, label };
        if (sessionStart) where.createdAt = { gte: sessionStart };
        const row = await prisma.covers.findFirst({
          where,
          orderBy: { id: 'desc' },
        });
        return send(res, 200, row?.covers ?? null, corsOrigin);
      }

      // Admin overview and trends
      if (req.method === 'GET' && pathname === '/admin/overview') {
        const [users, openShifts, openTables, revenueRows] = await Promise.all([
          prisma.user.count({ where: { active: true } }),
          prisma.dayShift.count({ where: { closedAt: null } }),
          (async () => {
            const key = 'tables:open';
            const row = await prisma.syncState
              .findUnique({ where: { key } })
              .catch(() => null);
            const map = ((row?.valueJson as any) || {}) as Record<
              string,
              boolean
            >;
            return Object.values(map).filter(Boolean).length;
          })(),
          prisma.ticketLog
            .findMany({
              where: {
                createdAt: {
                  gte: new Date(new Date().setHours(0, 0, 0, 0)),
                  lte: new Date(new Date().setHours(23, 59, 59, 999)),
                },
              },
              select: { itemsJson: true },
            })
            .catch(() => []),
        ]);
        const settings = await coreServices.readSettings();
        const fiscalVatEnabled = isVatEnabledFromSettings(settings);
        const fiscalDefaultVatRate = Number(
          (settings as any)?.defaultVatRate || 0,
        );
        const revenueTodayNet = (revenueRows as any[]).reduce(
          (s, r) =>
            s +
            sumTicketLinesNetVat(
              r.itemsJson,
              fiscalVatEnabled,
              fiscalDefaultVatRate,
            ).net,
          0,
        );
        const revenueTodayVat = (revenueRows as any[]).reduce(
          (s, r) =>
            s +
            sumTicketLinesNetVat(
              r.itemsJson,
              fiscalVatEnabled,
              fiscalDefaultVatRate,
            ).vat,
          0,
        );
        return send(
          res,
          200,
          {
            activeUsers: users,
            openShifts,
            openOrders: openTables,
            lowStockItems: 0,
            queuedPrintJobs: 0,
            lastMenuSync: null,
            lastStaffSync: null,
            printerIp: process.env.PRINTER_IP ?? null,
            appVersion: process.env.npm_package_version || '0.1.0',
            revenueTodayNet,
            revenueTodayVat,
            fiscalEnabled: fiscalVatEnabled,
          },
          corsOrigin,
        );
      }
      if (req.method === 'GET' && pathname === '/admin/sales-trends') {
        const range = (parsed.query.range as string) || 'daily';
        const today = new Date(new Date().setHours(0, 0, 0, 0));
        let buckets: { label: string; from: Date; to: Date }[] = [];
        if (range === 'daily') {
          const start = new Date(today.getTime() - 13 * 86400000);
          for (let i = 0; i < 14; i++) {
            const d = new Date(start.getTime() + i * 86400000);
            const from = new Date(d.setHours(0, 0, 0, 0));
            const to = new Date(d.setHours(23, 59, 59, 999));
            const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        } else if (range === 'weekly') {
          const start = new Date(today.getTime() - 7 * 86400000 * 11);
          for (let i = 0; i < 12; i++) {
            const from = new Date(start.getTime() + i * 7 * 86400000);
            const to = new Date(from.getTime() + 6 * 86400000);
            from.setHours(0, 0, 0, 0);
            to.setHours(23, 59, 59, 999);
            const oneJan = new Date(from.getFullYear(), 0, 1);
            const week = Math.ceil(
              ((from.getTime() - oneJan.getTime()) / 86400000 +
                oneJan.getDay() +
                1) /
                7,
            );
            const label = `${from.getFullYear()}-W${String(week).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        } else {
          const startYear = today.getFullYear();
          let m = today.getMonth() - 11;
          for (let i = 0; i < 12; i++, m++) {
            const year = startYear + Math.floor(m / 12);
            const month = ((m % 12) + 12) % 12;
            const from = new Date(year, month, 1, 0, 0, 0, 0);
            const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
            const label = `${year}-${String(month + 1).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        }
        const rows = await prisma.ticketLog.findMany({
          where: {
            createdAt: {
              gte: buckets[0].from,
              lte: buckets[buckets.length - 1].to,
            },
          },
          select: { createdAt: true, itemsJson: true },
          orderBy: { createdAt: 'asc' },
        });
        const points = buckets.map((b) => ({
          label: b.label,
          total: 0,
          orders: 0,
        }));
        for (const r of rows) {
          const when = new Date(r.createdAt);
          const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
          if (idx === -1) continue;
          const net = (r.itemsJson as any[]).reduce(
            (s: number, it: any) =>
              s + Number(it.unitPrice) * Number(it.qty || 1),
            0,
          );
          points[idx].total += net;
          points[idx].orders += 1;
        }
        return send(res, 200, { range, points }, corsOrigin);
      }

      // Waiter-facing reports (per-user)
      if (req.method === 'GET' && pathname === '/reports/my/overview') {
        const start = new Date(new Date().setHours(0, 0, 0, 0));
        const end = new Date();
        const rows = await prisma.ticketLog
          .findMany({
            where: {
              userId: auth!.userId,
              createdAt: { gte: start, lte: end },
            },
            select: { itemsJson: true },
          })
          .catch(() => []);
        const settings = await coreServices.readSettings();
        const fiscalVatEnabled = isVatEnabledFromSettings(settings);
        const fiscalDefaultVatRate = Number(
          (settings as any)?.defaultVatRate || 0,
        );
        const revenueTodayNet = (rows as any[]).reduce(
          (s, r) =>
            s +
            sumTicketLinesNetVat(
              r.itemsJson,
              fiscalVatEnabled,
              fiscalDefaultVatRate,
            ).net,
          0,
        );
        const revenueTodayVat = (rows as any[]).reduce(
          (s, r) =>
            s +
            sumTicketLinesNetVat(
              r.itemsJson,
              fiscalVatEnabled,
              fiscalDefaultVatRate,
            ).vat,
          0,
        );
        const openRow = await prisma.syncState
          .findUnique({ where: { key: 'tables:open' } })
          .catch(() => null);
        const openMap = ((openRow?.valueJson as any) || {}) as Record<
          string,
          boolean
        >;
        const openKeys = Object.entries(openMap)
          .filter(([, v]) => Boolean(v))
          .map(([k]) => k);
        const latestMatches = await Promise.all(
          openKeys.map(async (k) => {
            const [area, label] = k.split(':');
            if (!area || !label) return false;
            const last = await prisma.ticketLog
              .findFirst({
                where: { area, tableLabel: label },
                orderBy: { createdAt: 'desc' },
              })
              .catch(() => null);
            return Boolean(
              last && Number(last.userId) === Number(auth!.userId),
            );
          }),
        );
        const openOrders = latestMatches.filter(Boolean).length;
        return send(
          res,
          200,
          {
            revenueTodayNet,
            revenueTodayVat,
            openOrders,
            fiscalEnabled: fiscalVatEnabled,
          },
          corsOrigin,
        );
      }

      if (
        req.method === 'GET' &&
        pathname === '/reports/my/top-selling-today'
      ) {
        const start = new Date(new Date().setHours(0, 0, 0, 0));
        const end = new Date(new Date().setHours(23, 59, 59, 999));
        const rows = await prisma.ticketLog
          .findMany({
            where: {
              userId: auth!.userId,
              createdAt: { gte: start, lte: end },
            },
            select: { itemsJson: true },
          })
          .catch(() => []);
        const map = new Map<string, { qty: number; revenue: number }>();
        for (const r of rows as any[]) {
          const items = (r.itemsJson as any[]) || [];
          for (const it of items) {
            const name = String(it.name || 'Item');
            const qty = Number(it.qty || 1);
            const revenue = Number(it.unitPrice || 0) * qty;
            const entry = map.get(name) || { qty: 0, revenue: 0 };
            entry.qty += qty;
            entry.revenue += revenue;
            map.set(name, entry);
          }
        }
        let best: { name: string; qty: number; revenue: number } | null = null;
        for (const [name, v] of map.entries()) {
          if (!best || v.qty > best.qty)
            best = { name, qty: v.qty, revenue: v.revenue };
        }
        return send(res, 200, best, corsOrigin);
      }

      if (req.method === 'GET' && pathname === '/reports/my/sales-trends') {
        const range = (parsed.query.range as string) || 'daily';
        const today = new Date(new Date().setHours(0, 0, 0, 0));
        let buckets: { label: string; from: Date; to: Date }[] = [];
        if (range === 'daily') {
          const start = new Date(today.getTime() - 13 * 86400000);
          for (let i = 0; i < 14; i++) {
            const d = new Date(start.getTime() + i * 86400000);
            const from = new Date(d.setHours(0, 0, 0, 0));
            const to = new Date(d.setHours(23, 59, 59, 999));
            const label = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(from.getDate()).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        } else if (range === 'weekly') {
          const start = new Date(today.getTime() - 7 * 86400000 * 11);
          for (let i = 0; i < 12; i++) {
            const from = new Date(start.getTime() + i * 7 * 86400000);
            const to = new Date(from.getTime() + 6 * 86400000);
            from.setHours(0, 0, 0, 0);
            to.setHours(23, 59, 59, 999);
            const oneJan = new Date(from.getFullYear(), 0, 1);
            const week = Math.ceil(
              ((from.getTime() - oneJan.getTime()) / 86400000 +
                oneJan.getDay() +
                1) /
                7,
            );
            const label = `${from.getFullYear()}-W${String(week).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        } else {
          const startYear = today.getFullYear();
          let m = today.getMonth() - 11;
          for (let i = 0; i < 12; i++, m++) {
            const year = startYear + Math.floor(m / 12);
            const month = ((m % 12) + 12) % 12;
            const from = new Date(year, month, 1, 0, 0, 0, 0);
            const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
            const label = `${year}-${String(month + 1).padStart(2, '0')}`;
            buckets.push({ label, from, to });
          }
        }
        const rows = await prisma.ticketLog
          .findMany({
            where: {
              userId: auth!.userId,
              createdAt: {
                gte: buckets[0].from,
                lte: buckets[buckets.length - 1].to,
              },
            },
            select: { createdAt: true, itemsJson: true },
            orderBy: { createdAt: 'asc' },
          })
          .catch(() => []);
        const points = buckets.map((b) => ({
          label: b.label,
          total: 0,
          orders: 0,
        }));
        for (const r of rows as any[]) {
          const when = new Date(r.createdAt);
          const idx = buckets.findIndex((b) => when >= b.from && when <= b.to);
          if (idx === -1) continue;
          const net = (r.itemsJson as any[]).reduce(
            (s: number, it: any) =>
              s + Number(it.unitPrice) * Number(it.qty || 1),
            0,
          );
          points[idx].total += net;
          points[idx].orders += 1;
        }
        return send(res, 200, { range, points }, corsOrigin);
      }

      if (req.method === 'GET' && pathname === '/reports/my/active-tickets') {
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        const tickets = await listMyActiveTickets(auth.userId);
        return send(res, 200, tickets, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/reports/my/paid-tickets') {
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        const tickets = await listMyPaidTickets(
          auth.userId,
          String(parsed.query.q || ''),
          Number(parsed.query.limit || 40),
        );
        return send(res, 200, tickets, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/reports/my/voided-tickets') {
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        const tickets = await listMyVoidedTickets(
          auth.userId,
          Number(parsed.query.limit || 40),
        );
        return send(res, 200, tickets, corsOrigin);
      }

      // ----- Reservations (mobile / LAN HOST + ADMIN clients) -----
      // The reservations service throws errors with `statusCode` properties,
      // which the catch-all handler below already maps to the right HTTP code.
      // Auth is already enforced above (these are not in `publicPaths`), and
      // each service call additionally re-checks role from the local DB.
      const reservationActorId = Number(auth?.userId || 0);

      if (req.method === 'GET' && pathname === '/reservations') {
        const dateIso = parsed.query.dateIso
          ? String(parsed.query.dateIso)
          : '';
        const area = parsed.query.area ? String(parsed.query.area) : undefined;
        // Listing isn't a mutation, but we still gate on host/admin so an
        // arbitrary tablet token can't read the reservations book.
        await reservationsService.assertHostOrAdmin(reservationActorId);
        const list = await reservationsService.listReservationsForDay({
          dateIso,
          area,
        });
        return send(res, 200, list, corsOrigin);
      }

      if (req.method === 'GET' && pathname === '/reservations/counts') {
        const startIso = parsed.query.startIso
          ? String(parsed.query.startIso)
          : '';
        const endIso = parsed.query.endIso ? String(parsed.query.endIso) : '';
        await reservationsService.assertHostOrAdmin(reservationActorId);
        const counts = await reservationsService.listReservationCounts({
          startIso,
          endIso,
        });
        return send(res, 200, counts, corsOrigin);
      }

      if (req.method === 'GET' && pathname === '/reservations/merges') {
        const area = String(parsed.query.area || '');
        if (!area) return send(res, 400, 'invalid', corsOrigin);
        const groups = await readTableMerges(area);
        return send(res, 200, groups, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/reservations/merges') {
        const { area, groups } = await parseJson(req);
        if (!area) return send(res, 400, 'invalid', corsOrigin);
        console.info('[lan] save table merges', {
          area: String(area),
          role: auth?.role ?? null,
          userId: auth?.userId ?? null,
          groups: Array.isArray(groups) ? groups.length : 0,
        });
        const next = await writeTableMerges(String(area), groups);
        return send(res, 200, next, corsOrigin);
      }

      if (req.method === 'POST' && pathname === '/reservations') {
        const body = await parseJson(req);
        // The HTTP caller is the actor; ignore any client-supplied id so a
        // tablet can't impersonate another user when creating reservations.
        const created = await reservationsService.createReservation({
          ...(body || {}),
          createdById: reservationActorId,
        });
        return send(res, 200, created, corsOrigin);
      }

      if (req.method === 'POST' && pathname === '/reservations/update') {
        const body = await parseJson(req);
        const updated = await reservationsService.updateReservation({
          ...(body || {}),
          actorId: reservationActorId,
        });
        return send(res, 200, updated, corsOrigin);
      }

      if (req.method === 'POST' && pathname === '/reservations/set-status') {
        const body = await parseJson(req);
        const updated = await reservationsService.setReservationStatus({
          id: Number((body || {}).id || 0),
          status: String((body || {}).status || ''),
          actorId: reservationActorId,
        });
        return send(res, 200, updated, corsOrigin);
      }

      if (req.method === 'POST' && pathname === '/reservations/delete') {
        const body = await parseJson(req);
        const ok = await reservationsService.deleteReservation({
          id: Number((body || {}).id || 0),
          actorId: reservationActorId,
        });
        return send(res, 200, { ok }, corsOrigin);
      }

      // Fallback
      return send(res, 404, 'not found', corsOrigin);
    } catch (e: any) {
      const code = Number(e?.statusCode || 0);
      if (code === 413) return send(res, 413, 'payload too large');
      // Service-level errors (e.g. reservations service) attach `statusCode`
      // so we can map them to the right HTTP status without leaking internals.
      if (code === 401 || code === 403 || code === 404 || code === 409) {
        const message = String(e?.message || 'error');
        const errCode = String(e?.code || '');
        return send(res, code, { error: message, code: errCode || undefined });
      }
      console.error('API error', e);
      return send(res, 500, 'error');
    }
  };

  const server = http.createServer(handler);
  server.on('error', (err: any) => {
    const code = String(err?.code || '');
    if (code === 'EADDRINUSE') {
      console.warn(
        `HTTP API port already in use: http://${bindHost}:${httpPort} (another POS instance may be running).`,
      );
      return;
    }
    console.error('HTTP API server error', err);
  });
  server.listen(httpPort, bindHost, () => {
    console.log(`HTTP API listening on http://${bindHost}:${httpPort}`);
  });

  let httpsServer: https.Server | null = null;
  try {
    const tls = readTlsMaterial();
    if (!tls) {
      // Not an error: the LAN API is reachable over plain HTTP and that
      // is what the tablets use by default. HTTPS is opt-in and needs a
      // certificate the operator supplies.
      console.log(
        `HTTPS API disabled (no certificate). Drop key.pem/cert.pem in ${tlsCertDir()} to enable it.`,
      );
      throw new Error('no tls material');
    }
    httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, handler);
    httpsServer.on('error', (err: any) => {
      const code = String(err?.code || '');
      if (code === 'EADDRINUSE') {
        console.warn(
          `HTTPS API port already in use: https://${bindHost}:${httpsPort} (another POS instance may be running).`,
        );
        return;
      }
      console.error('HTTPS API server error', err);
    });
    httpsServer.listen(httpsPort, bindHost, () => {
      console.log(`HTTPS API listening on https://${bindHost}:${httpsPort}`);
    });
  } catch {
    // no TLS certs, skip HTTPS
  }

  return { http: server, https: httpsServer };
}
