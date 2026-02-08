import http from 'http';
import https from 'https';
import fs from 'fs';
import url from 'url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';
import {
  buildEscposTicket,
  buildHtmlReceipt,
  printHtmlToSystemPrinter,
  sendToCupsRawPrinter,
  sendToPrinter,
} from './print';
import { coreServices } from './services/core';
import { transferTableLocal } from './services/tableTransfer';
import { cloudJson, getCloudConfig } from './services/cloud';
import { isClockOnlyRole } from '@shared/utils/roles';

async function maybeAlertSuspiciousVoidsLocal(input: {
  actorUserId: number;
  kind: 'VOID_ITEM' | 'VOID_TICKET';
}) {
  // Conservative thresholds to avoid false accusations.
  const windowMinutes = 60;
  const threshold = input.kind === 'VOID_TICKET' ? 3 : 6;
  const cooldownMinutes = 60;
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const prefix = input.kind === 'VOID_TICKET' ? 'Voided ticket on ' : 'Voided item on ';

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
  const actionLabel = input.kind === 'VOID_TICKET' ? 'voided tickets' : 'voided items';
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
  if (!Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > windowMinutes * 60 * 1000) return;

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
  const actionLabel = input.kind === 'VOID_TICKET' ? 'voided a ticket' : 'voided an item';
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

let __kdsSchemaReady: boolean | null = null;
async function ensureKdsLocalSchema() {
  if (__kdsSchemaReady === true) return true;
  try {
    await (prisma as any).kdsDayCounter.count();
    __kdsSchemaReady = true;
    return true;
  } catch {
    // continue
  }
  try {
    // MenuItem.station (ignore if already exists)
    try {
      await (prisma as any).$executeRawUnsafe(
        `ALTER TABLE "MenuItem" ADD COLUMN "station" TEXT NOT NULL DEFAULT 'KITCHEN';`,
      );
    } catch {
      // ignore
    }
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsDayCounter" ("dayKey" TEXT NOT NULL PRIMARY KEY, "lastNo" INTEGER NOT NULL DEFAULT 0);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsOrder" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "dayKey" TEXT NOT NULL, "orderNo" INTEGER NOT NULL, "area" TEXT NOT NULL, "tableLabel" TEXT NOT NULL, "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "closedAt" DATETIME);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "KdsOrder_dayKey_orderNo_key" ON "KdsOrder"("dayKey","orderNo");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsOrder_area_tableLabel_closedAt_idx" ON "KdsOrder"("area","tableLabel","closedAt");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsTicket" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "orderId" INTEGER NOT NULL, "userId" INTEGER, "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "itemsJson" JSONB NOT NULL, "note" TEXT, CONSTRAINT "KdsTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "KdsOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "KdsTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsTicket_orderId_firedAt_idx" ON "KdsTicket"("orderId","firedAt");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsTicketStation" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "ticketId" INTEGER NOT NULL, "station" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'NEW', "bumpedAt" DATETIME, "bumpedById" INTEGER, CONSTRAINT "KdsTicketStation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KdsTicket" ("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "KdsTicketStation_bumpedById_fkey" FOREIGN KEY ("bumpedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "KdsTicketStation_ticketId_station_key" ON "KdsTicketStation"("ticketId","station");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsTicketStation_station_status_bumpedAt_idx" ON "KdsTicketStation"("station","status","bumpedAt");`,
    );
    __kdsSchemaReady = true;
    return true;
  } catch {
    __kdsSchemaReady = false;
    return false;
  }
}

// Suspicious-pattern detection (best-effort, in-memory).
const mgrPinFailByIp = new Map<string, { count: number; resetAt: number; lastAlertAt: number }>();

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

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function readCloudSessionFromLocalSettings(): Promise<{
  backendUrl: string;
  businessCode: string;
  token: string;
} | null> {
  try {
    const s: any = await coreServices.readSettings().catch(() => null);
    const backendUrl = String(s?.cloud?.backendUrl || '')
      .trim()
      .replace(/\/+$/g, '');
    const businessCode = String(s?.cloud?.businessCode || '')
      .trim()
      .toUpperCase();
    if (!backendUrl || !businessCode) return null;
    const keys = [
      'cloud:session:staff',
      'cloud:session:admin',
      'cloud:session',
    ];
    for (const k of keys) {
      const row = await prisma.syncState
        .findUnique({ where: { key: k } })
        .catch(() => null);
      const v: any = (row?.valueJson as any) || null;
      const token = String(v?.token || '').trim();
      const bc = String(v?.businessCode || '')
        .trim()
        .toUpperCase();
      if (token && bc === businessCode)
        return { backendUrl, businessCode, token };
    }
    return null;
  } catch {
    return null;
  }
}

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

async function parseJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
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
  if (!payload?.sub || typeof payload.sub !== 'number') return null;
  if (typeof payload.exp === 'number' && payload.exp < now) return null;
  return { userId: payload.sub, role: payload.role };
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
  const dev = isDev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [];
  const allowList = new Set<string>([...extra, ...dev]);

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
      'Content-Type, Authorization, Idempotency-Key',
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

// Basic in-memory rate limit for login attempts (per remote IP)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function allowLoginAttempt(
  remoteIp: string,
  maxPerWindow = 20,
  windowMs = 10 * 60 * 1000,
) {
  const now = Date.now();
  const cur = loginAttempts.get(remoteIp);
  if (!cur || cur.resetAt <= now) {
    loginAttempts.set(remoteIp, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (cur.count >= maxPerWindow) return false;
  cur.count += 1;
  loginAttempts.set(remoteIp, cur);
  return true;
}

export async function startApiServer(httpPort = 3333, httpsPort = 3443) {
  const CURRENT_FILE = fileURLToPath(import.meta.url);
  const CURRENT_DIR = dirname(CURRENT_FILE);
  const RENDERER_DIR = join(CURRENT_DIR, '../renderer');
  const RENDERER_ORIGIN = process.env.RENDERER_ORIGIN || '';
  const settings = await coreServices.readSettings();
  const allowLan =
    Boolean((settings as any)?.security?.allowLan) ||
    process.env.POS_ALLOW_LAN === 'true';
  const bindHost =
    process.env.POS_BIND_HOST || (allowLan ? '0.0.0.0' : '127.0.0.1');
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

      // Helper: resolve printer host/port from env or stored settings
      async function resolvePrinter() {
        const s = await coreServices.readSettings();
        const ip = process.env.PRINTER_IP || s?.printer?.ip;
        const port = Number(
          process.env.PRINTER_PORT || s?.printer?.port || 9100,
        );
        return { ip, port } as { ip?: string; port: number };
      }

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
                'Content-Type': getContentType(upstreamPath),
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
      // Verify pairing code (used by tablets before cloud login)
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
          if (!lanEnabled)
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
        const remoteIp = String(
          (req.socket as any)?.remoteAddress || 'unknown',
        );
        if (!allowLoginAttempt(remoteIp))
          return send(res, 429, { error: 'too many attempts' }, corsOrigin);
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
          if (
            lanEnabled &&
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
          role: user.role,
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
        // In cloud mode, proxy the cloud public users endpoint so tablets don't need the provider-supplied business password.
        const cloudCfg = await getCloudConfig().catch(() => null);
        if (cloudCfg) {
          try {
            const s: any = await coreServices.readSettings().catch(() => null);
            const pw = String(s?.cloud?.accessPassword || '').trim();
            const url = `${cloudCfg.backendUrl}/auth/public-users?businessCode=${encodeURIComponent(String(cloudCfg.businessCode))}&includeAdmins=1`;
            const r = await fetch(url, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                ...(pw ? { 'x-business-password': pw } : {}),
              } as any,
            } as any).catch(() => null as any);
            if (r && r.ok) {
              const data = await r.json().catch(() => null);
              if (Array.isArray(data)) return send(res, 200, data, corsOrigin);
            }
          } catch {
            // fall back to local
          }
        }
        const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
        return send(
          res,
          200,
          users.map((u: any) => ({
            id: u.id,
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
        '/kds/bump',
        '/kds/bump-item',
        '/kds/debug',
        '/shifts/open',
        '/settings',
        '/offline/status',
      ]);
      const isPublic = publicPaths.has(pathname) || isStaticGet;
      let auth: AuthContext = null;
      if (!isPublic) {
        const token = pickBearerToken(req, parsed);
        auth = token ? await verifyToken(secret, token) : null;
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
      }

      // Clock-only roles (KP/CHEF/HEAD_CHEF) are allowed to use ONLY shift endpoints.
      // This enforces "can only clock in/out" for LAN browser clients.
      if (auth && isClockOnlyRole((auth as any).role)) {
        const allowed = new Set<string>([
          '/shifts/open',
          '/shifts/get-open',
          '/shifts/clock-in',
          '/shifts/clock-out',
          '/shifts/public-open',
        ]);
        if (!allowed.has(pathname))
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
          mgrPinFailByIp.set(remoteIp, { count: 0, resetAt: now + windowMinutes * 60 * 1000, lastAlertAt: cur?.lastAlertAt || 0 });
        }
        const cloud = await getCloudConfig().catch(() => null);
        if (cloud) {
          try {
            const r = await cloudJson(
              'POST',
              '/auth/verify-manager-pin',
              { businessCode: cloud.businessCode, pin: p },
              { requireAuth: false, senderId: 0 },
            );
            if (!(r && typeof r === 'object' && (r as any).ok === true)) {
              const st = mgrPinFailByIp.get(remoteIp)!;
              st.count += 1;
              mgrPinFailByIp.set(remoteIp, st);
              if (st.count >= threshold && (!st.lastAlertAt || now - st.lastAlertAt > cooldownMinutes * 60 * 1000)) {
                const admins = await prisma.user.findMany({ where: { role: 'ADMIN', active: true } as any, take: 50 }).catch(() => []);
                const msg =
                  `Unusual activity (auto-check): ${st.count} manager PIN verification failures in the last ${windowMinutes} minutes` +
                  `${remoteIp ? ` from IP ${remoteIp}` : ''}. ` +
                  `This can be normal (mistyped PINs); please review if unexpected.`;
                for (const a of admins as any[]) {
                  await prisma.notification.create({ data: { userId: a.id, type: 'SECURITY' as any, message: msg } as any }).catch(() => {});
                }
                st.lastAlertAt = now;
                mgrPinFailByIp.set(remoteIp, st);
              }
            } else {
              const st = mgrPinFailByIp.get(remoteIp);
              if (st) mgrPinFailByIp.set(remoteIp, { ...st, count: 0 });
            }
            return send(
              res,
              200,
              r && typeof r === 'object' ? r : { ok: false },
              corsOrigin,
            );
          } catch {
            return send(res, 200, { ok: false }, corsOrigin);
          }
        }
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
          if (ok)
            // success resets counter
            {
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
        if (st.count >= threshold && (!st.lastAlertAt || now - st.lastAlertAt > cooldownMinutes * 60 * 1000)) {
          const msg =
            `Unusual activity (auto-check): ${st.count} manager PIN verification failures in the last ${windowMinutes} minutes` +
            `${remoteIp ? ` from IP ${remoteIp}` : ''}. ` +
            `This can be normal (mistyped PINs); please review if unexpected.`;
          for (const a of admins as any[]) {
            await prisma.notification.create({ data: { userId: a.id, type: 'SECURITY' as any, message: msg } as any }).catch(() => {});
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
            items: c.items.map((i: any) => ({
              id: i.id,
              name: i.name,
              sku: i.sku,
              price: Number(i.price),
              vatRate: Number(i.vatRate),
              active: i.active,
              categoryId: i.categoryId,
            })),
          })),
          corsOrigin,
        );
      }

      // Tickets
      if (req.method === 'POST' && pathname === '/tickets') {
        const { userId, area, tableLabel, covers, items, note } =
          await parseJson(req);
        if (!userId || !area || !tableLabel)
          return send(res, 400, 'invalid payload', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        await prisma.ticketLog.create({
          data: {
            userId: Number(userId),
            area: String(area),
            tableLabel: String(tableLabel),
            covers: covers ? Number(covers) : null,
            itemsJson: items ?? [],
            note: note ? String(note) : null,
          },
        });
        // Best-effort: also create KDS ticket on the host, so kitchen clients see orders.
        try {
          const ok = await ensureKdsLocalSchema();
          if (ok) {
            const enabledStationsRaw = (
              await coreServices.readSettings().catch(() => null as any)
            )?.kds?.enabledStations;
            const enabledStations = new Set(
              (Array.isArray(enabledStationsRaw)
                ? enabledStationsRaw
                : ['KITCHEN']
              ).map((x: any) => String(x).toUpperCase()),
            );
            if (enabledStations.size === 0) enabledStations.add('KITCHEN');
            const fallbackStation = enabledStations.has('KITCHEN')
              ? 'KITCHEN'
              : Array.from(enabledStations)[0] || 'KITCHEN';
            const lines = Array.isArray(items) ? items : [];
            const skus = Array.from(
              new Set(
                lines
                  .map((it: any) => String(it?.sku || '').trim())
                  .filter(Boolean),
              ),
            );
            const skuToStation: Record<string, string> = {};
            if (skus.length) {
              const menuRows = await prisma.menuItem
                .findMany({
                  where: { sku: { in: skus } },
                  select: { sku: true, station: true },
                } as any)
                .catch(() => []);
              for (const r of menuRows as any[]) {
                const st = String(
                  (r as any)?.station || 'KITCHEN',
                ).toUpperCase();
                skuToStation[String((r as any)?.sku || '')] =
                  enabledStations.has(st) ? st : fallbackStation;
              }
            }
            const decorated = lines.map((it: any) => {
              const sku = String(it?.sku || '').trim();
              const stRaw = sku ? skuToStation[sku] : '';
              const st = enabledStations.has(String(stRaw || '').toUpperCase())
                ? String(stRaw).toUpperCase()
                : enabledStations.has('KITCHEN')
                  ? 'KITCHEN'
                  : fallbackStation;
              return { ...it, station: st };
            });
            const usedStations = Array.from(
              new Set(
                decorated
                  .map((it: any) => String(it?.station || '').toUpperCase())
                  .filter((s) => enabledStations.has(s)),
              ),
            );
            if (usedStations.length) {
              const now = new Date();
              const dayKey = dayKeyLocal(now);
              await (prisma as any).$transaction(async (tx: any) => {
                let order = await tx.kdsOrder.findFirst({
                  where: {
                    area: String(area),
                    tableLabel: String(tableLabel),
                    closedAt: null,
                  },
                  orderBy: { openedAt: 'desc' },
                });
                if (!order) {
                  const counter = await tx.kdsDayCounter.upsert({
                    where: { dayKey },
                    create: { dayKey, lastNo: 0 },
                    update: {},
                  });
                  const nextNo = Number(counter?.lastNo || 0) + 1;
                  await tx.kdsDayCounter.update({
                    where: { dayKey },
                    data: { lastNo: nextNo },
                  });
                  order = await tx.kdsOrder.create({
                    data: {
                      dayKey,
                      orderNo: nextNo,
                      area: String(area),
                      tableLabel: String(tableLabel),
                      openedAt: now,
                    },
                  });
                }
                const ticket = await tx.kdsTicket.create({
                  data: {
                    orderId: order.id,
                    userId: Number(userId),
                    firedAt: now,
                    itemsJson: decorated,
                    note: note ? String(note) : null,
                  },
                });
                for (const st of usedStations) {
                  await tx.kdsTicketStation.create({
                    data: { ticketId: ticket.id, station: st, status: 'NEW' },
                  });
                }
              });
            }
          }
        } catch {
          // ignore
        }
        // broadcast change
        try {
          const clients: Set<any> =
            (globalThis as any).__SSE_CLIENTS__ || new Set();
          const evt = `event: ticket\ndata: ${JSON.stringify({ area, tableLabel })}\n\n`;
          clients.forEach((c: any) => c.res.write(evt));
        } catch (e) {
          void e;
        }
        return send(res, 201, 'ok', corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/tickets/latest') {
        const area = String(parsed.query.area || '');
        const tableLabel = String(parsed.query.table || '');
        if (!area || !tableLabel) return send(res, 400, 'invalid', corsOrigin);
        const last = await prisma.ticketLog.findFirst({
          where: { area, tableLabel },
          orderBy: { createdAt: 'desc' },
        });
        if (!last) return send(res, 200, null, corsOrigin);
        const items = (((last.itemsJson as any) || []) as any[]).filter(
          (it: any) => !it?.voided,
        );
        return send(
          res,
          200,
          {
            items,
            note: last.note ?? null,
            covers: last.covers ?? null,
            createdAt: last.createdAt.toISOString(),
            userId: last.userId,
          },
          corsOrigin,
        );
      }

      // KDS endpoints should be usable by dedicated kitchen devices without login.
      // (Bump attribution is optional and best-effort.)

      // KDS (LAN): list station tickets and bump
      if (req.method === 'GET' && pathname === '/kds/tickets') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
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
        const rows = await (prisma as any).kdsTicketStation.findMany({
          where: { station, status },
          include: { ticket: { include: { order: true } } },
          orderBy:
            status === 'NEW'
              ? { ticket: { firedAt: 'asc' } }
              : { bumpedAt: 'desc' },
          take: limit,
        });
        const out = (rows as any[])
          .map((r: any) => {
            const t = r.ticket;
            const o = t?.order;
            const itemsAll = Array.isArray(t?.itemsJson) ? t.itemsJson : [];
            const items = itemsAll
              .map((it: any, idx: number) => ({ ...it, _idx: idx }))
              .filter(
                (it: any) =>
                  String(it?.station || '').toUpperCase() === station &&
                  !it?.voided,
              )
              .filter((it: any) => (status === 'NEW' ? !it?.bumped : true));
            if (status === 'NEW' && items.length === 0) return null;
            return {
              ticketId: t?.id,
              orderNo: o?.orderNo,
              area: o?.area,
              tableLabel: o?.tableLabel,
              firedAt: t?.firedAt?.toISOString?.() ?? null,
              note: t?.note ?? null,
              items,
              bumpedAt: r?.bumpedAt?.toISOString?.() ?? null,
            };
          })
          .filter(Boolean);
        return send(res, 200, out, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/kds/bump') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const { station, ticketId } = await parseJson(req);
        const st = String(station || 'KITCHEN').toUpperCase();
        const id = Number(ticketId || 0);
        if (!id) return send(res, 400, { error: 'invalid' }, corsOrigin);
        const updated = await (prisma as any).kdsTicketStation.updateMany({
          where: { ticketId: id, station: st, status: 'NEW' },
          data: {
            status: 'DONE',
            bumpedAt: new Date(),
            bumpedById: auth?.userId || null,
          },
        });
        return send(res, 200, { ok: Boolean(updated?.count) }, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/kds/bump-item') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const { station, ticketId, itemIdx } = await parseJson(req);
        const st = String(station || 'KITCHEN').toUpperCase();
        const id = Number(ticketId || 0);
        const idx = Number(itemIdx ?? -1);
        if (!id || !Number.isFinite(idx) || idx < 0)
          return send(res, 400, { error: 'invalid' }, corsOrigin);
        const now = new Date();
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
      if (req.method === 'GET' && pathname === '/kds/debug') {
        const ok = await ensureKdsLocalSchema();
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
        return send(res, 200, { schemaReady: ok, counts }, corsOrigin);
      }

      // Printing: test and ticket (for browser clients on LAN). Printing happens on the host machine.
      if (req.method === 'POST' && pathname === '/print/test') {
        const row = await prisma.syncState
          .findUnique({ where: { key: 'settings' } })
          .catch(() => null);
        const settings = (row?.valueJson as any) || {
          restaurantName: ' Code Orbit Agroturizem',
          currency: 'EUR',
          defaultVatRate: 0.2,
        };
        const mode = (settings?.printer?.mode ||
          (settings?.printer?.serialPath
            ? 'SERIAL'
            : settings?.printer?.deviceName
              ? 'SYSTEM'
              : 'NETWORK')) as any;
        if (mode === 'SYSTEM') {
          // Default ON: receipt printers expect raw ESC/POS, not PostScript/PDF
          const raw = settings?.printer?.systemRawEscpos !== false;
          if (raw) {
            const data = Buffer.from(
              [
                '\x1b@',
                ' Code Orbit POS Test Print\n',
                '-------------------------\n',
                new Date().toISOString() + '\n\n',
                '\x1dV\x41\x10',
              ].join(''),
              'binary',
            );
            const r = await sendToCupsRawPrinter({
              deviceName: settings?.printer?.deviceName,
              data,
            });
            return send(
              res,
              r.ok ? 200 : 500,
              { ok: r.ok, error: r.error },
              corsOrigin,
            );
          } else {
            const html = buildHtmlReceipt(
              {
                area: 'TEST',
                tableLabel: 'USB',
                covers: null,
                items: [
                  { name: 'Test item', qty: 1, unitPrice: 1.0, vatRate: 0 },
                ],
                note: null,
                userName: 'POS',
                meta: { vatEnabled: true },
              } as any,
              settings as any,
            );
            const r = await printHtmlToSystemPrinter({
              html,
              deviceName: settings?.printer?.deviceName,
              silent: settings?.printer?.silent !== false,
            });
            return send(
              res,
              r.ok ? 200 : 500,
              { ok: r.ok, error: r.error },
              corsOrigin,
            );
          }
        }
        if (mode === 'SERIAL') {
          const p: any = settings?.printer || {};
          const cfg = {
            path: String(p.serialPath || ''),
            baudRate: Number(p.baudRate || 19200),
            dataBits: (Number(p.dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
            stopBits: (Number(p.stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
            parity: String(p.parity || 'none') as any as
              | 'none'
              | 'even'
              | 'odd',
          };
          if (!cfg.path)
            return send(
              res,
              400,
              { ok: false, error: 'Serial port not configured' },
              corsOrigin,
            );
          const data = Buffer.from(
            [
              '\x1b@',
              ' Code Orbit POS Test Print\n',
              '-------------------------\n',
              new Date().toISOString() + '\n\n',
              '\x1dV\x41\x10',
            ].join(''),
            'binary',
          );
          const { sendToSerialPrinter } = await import('./serial');
          const r = await sendToSerialPrinter(cfg as any, data);
          return send(
            res,
            r.ok ? 200 : 500,
            { ok: r.ok, error: r.error },
            corsOrigin,
          );
        }
        const { ip, port } = await resolvePrinter();
        if (!ip)
          return send(
            res,
            400,
            { ok: false, error: 'Printer IP not configured' },
            corsOrigin,
          );
        const data = Buffer.from(
          [
            '\x1b@',
            ' Code Orbit POS Test Print\n',
            '-------------------------\n',
            new Date().toISOString() + '\n\n',
            '\x1dV\x41\x10',
          ].join(''),
          'binary',
        );
        const ok = await sendToPrinter(ip, port, data);
        return send(res, ok ? 200 : 500, { ok }, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/print/ticket') {
        const body = await parseJson(req);
        const payload = {
          area: String(body?.area || ''),
          tableLabel: String(body?.tableLabel || ''),
          covers: body?.covers ?? null,
          items: Array.isArray(body?.items) ? body.items : [],
          note: body?.note ?? null,
          userName: body?.userName || undefined,
          meta: body?.meta ?? undefined,
        } as any;
        if (!payload.area || !payload.tableLabel || payload.items.length === 0)
          return send(
            res,
            400,
            { ok: false, error: 'invalid payload' },
            corsOrigin,
          );
        const row = await prisma.syncState
          .findUnique({ where: { key: 'settings' } })
          .catch(() => null);
        const settings = (row?.valueJson as any) || {
          restaurantName: ' Code Orbit Agroturizem',
          currency: 'EUR',
          defaultVatRate: 0.2,
        };
        const mode = (settings?.printer?.mode ||
          (settings?.printer?.serialPath
            ? 'SERIAL'
            : settings?.printer?.deviceName
              ? 'SYSTEM'
              : 'NETWORK')) as any;

        // Track last payment time per table + payment adjustment alerts.
        // Run before printing so it works for all printer modes.
        try {
          const meta: any = payload?.meta || {};
          const kind = String(meta?.kind || '').toUpperCase();
          if (kind === 'PAYMENT') {
            const k = `${payload.area}:${payload.tableLabel}`;
            const payRow = await prisma.syncState
              .findUnique({ where: { key: 'antitheft:lastPaymentAt' } })
              .catch(() => null as any);
            const map = ((payRow?.valueJson as any) || {}) as Record<string, string>;
            map[k] = new Date().toISOString();
            if (payRow?.key) {
              await prisma.syncState
                .update({ where: { key: 'antitheft:lastPaymentAt' }, data: { valueJson: map } as any })
                .catch(() => null);
            } else {
              await prisma.syncState
                .create({ data: { key: 'antitheft:lastPaymentAt', valueJson: map } as any })
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
              if (Number.isFinite(discountAmt) && discountAmt > 0) st.discountCount += 1;
              if (scEnabled && !scApplied && Number.isFinite(scAmt) && scAmt > 0) st.serviceRemovalCount += 1;
              payAdjustByUser.set(userId, st);

              const actor = await prisma.user.findUnique({ where: { id: userId } }).catch(() => null as any);
              const actorName = actor?.displayName ? String(actor.displayName) : `User #${userId}`;
              const admins = await prisma.user.findMany({ where: { role: 'ADMIN', active: true } as any, take: 50 }).catch(() => []);
              const canAlert = !st.lastAlertAt || now - st.lastAlertAt > cooldownMinutes * 60 * 1000;

              if (canAlert && st.discountCount >= 5) {
                const msg =
                  `Unusual activity (auto-check): ${st.discountCount} discounted payments by ${actorName} in the last ${windowMinutes} minutes. ` +
                  `This can be normal during promotions; please review if unexpected.`;
                for (const a of admins as any[]) {
                  await prisma.notification.create({ data: { userId: a.id, type: 'SECURITY' as any, message: msg } as any }).catch(() => {});
                }
                st.lastAlertAt = now;
                payAdjustByUser.set(userId, st);
              } else if (canAlert && st.serviceRemovalCount >= 3) {
                const msg =
                  `Unusual activity (auto-check): ${st.serviceRemovalCount} service charge removals by ${actorName} in the last ${windowMinutes} minutes. ` +
                  `This can be normal during corrections; please review if unexpected.`;
                for (const a of admins as any[]) {
                  await prisma.notification.create({ data: { userId: a.id, type: 'SECURITY' as any, message: msg } as any }).catch(() => {});
                }
                st.lastAlertAt = now;
                payAdjustByUser.set(userId, st);
              }
            }
          }
        } catch {
          // ignore
        }

        if (mode === 'SYSTEM') {
          // Default ON: receipt printers expect raw ESC/POS, not PostScript/PDF
          const raw = settings?.printer?.systemRawEscpos !== false;
          if (raw) {
            const buf = buildEscposTicket(payload, settings);
            const r = await sendToCupsRawPrinter({
              deviceName: settings?.printer?.deviceName,
              data: buf,
            });
            return send(
              res,
              r.ok ? 200 : 500,
              { ok: r.ok, error: r.error },
              corsOrigin,
            );
          } else {
            const html = buildHtmlReceipt(payload, settings as any);
            const r = await printHtmlToSystemPrinter({
              html,
              deviceName: settings?.printer?.deviceName,
              silent: settings?.printer?.silent !== false,
            });
            return send(
              res,
              r.ok ? 200 : 500,
              { ok: r.ok, error: r.error },
              corsOrigin,
            );
          }
        }
        if (mode === 'SERIAL') {
          const p: any = settings?.printer || {};
          const cfg = {
            path: String(p.serialPath || ''),
            baudRate: Number(p.baudRate || 19200),
            dataBits: (Number(p.dataBits || 8) === 7 ? 7 : 8) as 7 | 8,
            stopBits: (Number(p.stopBits || 1) === 2 ? 2 : 1) as 1 | 2,
            parity: String(p.parity || 'none') as any as
              | 'none'
              | 'even'
              | 'odd',
          };
          if (!cfg.path)
            return send(
              res,
              400,
              { ok: false, error: 'Serial port not configured' },
              corsOrigin,
            );
          const buf = buildEscposTicket(payload, settings);
          const { sendToSerialPrinter } = await import('./serial');
          const r = await sendToSerialPrinter(cfg as any, buf);
          return send(
            res,
            r.ok ? 200 : 500,
            { ok: r.ok, error: r.error },
            corsOrigin,
          );
        }
        const { ip, port } = await resolvePrinter();
        if (!ip)
          return send(
            res,
            400,
            { ok: false, error: 'Printer IP not configured' },
            corsOrigin,
          );
        const buf = buildEscposTicket(payload, settings);
        const ok = await sendToPrinter(ip, port, buf);
        return send(res, ok ? 200 : 500, { ok }, corsOrigin);
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
            const approved = tok ? await verifyApprovalToken(secret, tok) : null;
            if (!approved || approved.userId !== aid || String((approved as any).role || '').toUpperCase() !== 'ADMIN')
              return send(res, 403, { error: 'admin_approval_required' }, corsOrigin);
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
          const idx = items.findIndex((it: any) => it.name === item.name);
          if (idx !== -1) {
            items[idx] = { ...items[idx], voided: true };
            await prisma.ticketLog.update({
              where: { id: last.id },
              data: { itemsJson: items },
            });
          }
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
            const approved = tok ? await verifyApprovalToken(secret, tok) : null;
            if (!approved || approved.userId !== aid || String((approved as any).role || '').toUpperCase() !== 'ADMIN')
              return send(res, 403, { error: 'admin_approval_required' }, corsOrigin);
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
        // Also mark table free
        try {
          const key = 'tables:open';
          const row = await prisma.syncState.findUnique({ where: { key } });
          const map = ((row?.valueJson as any) || {}) as Record<
            string,
            boolean
          >;
          const k = `${area}:${tableLabel}`;
          if (map[k]) {
            delete map[k];
            await prisma.syncState.upsert({
              where: { key },
              create: { key, valueJson: map },
              update: { valueJson: map },
            });
          }
        } catch (e) {
          void e;
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
        const key = 'tables:open';
        const row = await prisma.syncState.findUnique({ where: { key } });
        const map = ((row?.valueJson as any) || {}) as Record<string, boolean>;
        const k = `${area}:${label}`;
        if (open) map[k] = true;
        else delete map[k];
        await prisma.syncState.upsert({
          where: { key },
          create: { key, valueJson: map },
          update: { valueJson: map },
        });
        // broadcast table status
        try {
          const clients: Set<any> =
            (globalThis as any).__SSE_CLIENTS__ || new Set();
          const evt = `event: tables\ndata: ${JSON.stringify({ area, label, open })}\n\n`;
          clients.forEach((c: any) => c.res.write(evt));
        } catch (e) {
          void e;
        }
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
        } as any).catch((e: any) => ({
          ok: false as const,
          error: String(e?.message || e || 'Transfer failed'),
        }));
        return send(res, 200, r, corsOrigin);
      }

      // Layout: get/save for browser clients
      if (req.method === 'GET' && pathname === '/layout/get') {
        const userId = Number(parsed.query.userId || 0);
        const area = String(parsed.query.area || '');
        if (!userId || !area) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const key = `layout:${userId}:${area}`;
        const row = await prisma.syncState
          .findUnique({ where: { key } })
          .catch(() => null);
        return send(
          res,
          200,
          (row?.valueJson as any)?.nodes ?? null,
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/layout/save') {
        const { userId, area, nodes } = await parseJson(req);
        if (!userId || !area || !Array.isArray(nodes))
          return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const key = `layout:${Number(userId)}:${String(area)}`;
        await prisma.syncState.upsert({
          where: { key },
          create: { key, valueJson: { nodes } },
          update: { valueJson: { nodes } },
        });
        return send(res, 200, 'ok', corsOrigin);
      }

      // Shifts (open userIds)
      if (req.method === 'GET' && pathname === '/shifts/open') {
        // In cloud mode, proxy open shifts from the cloud backend so tablets see correct clock-in state even before login.
        const cloud = await readCloudSessionFromLocalSettings();
        if (cloud?.token && cloud?.backendUrl) {
          try {
            const r = await fetch(`${cloud.backendUrl}/shifts/open`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${cloud.token}` },
            } as any);
            if (r.ok) {
              const data = await r.json().catch(() => null);
              if (Array.isArray(data)) return send(res, 200, data, corsOrigin);
            }
            // Token invalid/expired → use public endpoint as fallback (prevents false "clocked out" UI).
            if (r.status === 401 || r.status === 403) {
              const s: any = await coreServices
                .readSettings()
                .catch(() => null);
              const pw = String(s?.cloud?.accessPassword || '').trim();
              const pr = await fetch(
                `${cloud.backendUrl}/shifts/public-open?businessCode=${encodeURIComponent(cloud.businessCode)}`,
                {
                  method: 'GET',
                  headers: {
                    Accept: 'application/json',
                    ...(pw ? { 'x-business-password': pw } : {}),
                  } as any,
                } as any,
              ).catch(() => null as any);
              if (pr && pr.ok) {
                const pdata = await pr.json().catch(() => null);
                if (Array.isArray(pdata))
                  return send(res, 200, pdata, corsOrigin);
              }
            }
          } catch {
            // fall back to local
          }
        }
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
        const { userId } = await parseJson(req);
        if (!userId) return send(res, 400, 'invalid', corsOrigin);
        if (auth && Number(userId) !== auth.userId && auth.role !== 'ADMIN')
          return send(res, 403, { error: 'forbidden' }, corsOrigin);
        const open = await prisma.dayShift.findFirst({
          where: { closedAt: null, openedById: Number(userId) },
        });
        if (!open) return send(res, 200, null, corsOrigin);
        const updated = await prisma.dayShift.update({
          where: { id: open.id },
          data: { closedAt: new Date(), closedById: Number(userId) },
        });
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

      // Settings: get and update (for browser clients)
      if (req.method === 'GET' && pathname === '/settings') {
        const base = await coreServices.readSettings();
        const result = {
          ...base,
          printer: {
            ip: base.printer?.ip || null,
            port: Number(base.printer?.port || 9100),
          },
        } as any;
        if (result?.security && typeof result.security === 'object') {
          result.security = { ...result.security };
          delete result.security.apiSecret;
        }
        // Never expose provider-supplied business password to tablets/LAN clients.
        if (result?.cloud && typeof result.cloud === 'object') {
          result.cloud = { ...result.cloud };
          delete result.cloud.accessPassword;
        }
        return send(res, 200, result, corsOrigin);
      }
      // Offline outbox status (for tablets / browser clients)
      if (req.method === 'GET' && pathname === '/offline/status') {
        try {
          const { getOutboxStatus } = await import('./services/offlineOutbox');
          const st = await getOutboxStatus();
          return send(res, 200, st, corsOrigin);
        } catch {
          return send(res, 200, { queued: 0 }, corsOrigin);
        }
      }
      if (req.method === 'POST' && pathname === '/settings/update') {
        try {
          const input = await parseJson(req);
          const merged = await coreServices.updateSettings(input);
          return send(res, 200, merged, corsOrigin);
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
        const row = await prisma.covers.findFirst({
          where: { area, label },
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
        const revenueTodayNet = (revenueRows as any[]).reduce(
          (s, r) =>
            s +
            (r.itemsJson as any[]).reduce(
              (ss: number, it: any) =>
                ss + Number(it.unitPrice) * Number(it.qty || 1),
              0,
            ),
          0,
        );
        const revenueTodayVat = (revenueRows as any[]).reduce(
          (s, r) =>
            s +
            (r.itemsJson as any[]).reduce(
              (ss: number, it: any) =>
                ss +
                Number(it.unitPrice) *
                  Number(it.qty || 1) *
                  Number(it.vatRate || 0),
              0,
            ),
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
        const revenueTodayNet = (rows as any[]).reduce(
          (s, r) =>
            s +
            (r.itemsJson as any[]).reduce(
              (ss: number, it: any) =>
                ss + Number(it.unitPrice) * Number(it.qty || 1),
              0,
            ),
          0,
        );
        const revenueTodayVat = (rows as any[]).reduce(
          (s, r) =>
            s +
            (r.itemsJson as any[]).reduce(
              (ss: number, it: any) =>
                ss +
                Number(it.unitPrice) *
                  Number(it.qty || 1) *
                  Number(it.vatRate || 0),
              0,
            ),
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
          { revenueTodayNet, revenueTodayVat, openOrders },
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

      // Fallback
      return send(res, 404, 'not found', corsOrigin);
    } catch (e) {
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

  try {
    const key = fs.readFileSync('key.pem');
    const cert = fs.readFileSync('cert.pem');
    const httpsServer = https.createServer({ key, cert }, handler);
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

  return server;
}
