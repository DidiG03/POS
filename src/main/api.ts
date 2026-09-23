import http from 'http';
import https from 'https';
import fs from 'fs';
import url from 'url';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { prisma } from '@db/client';
import bcrypt from 'bcryptjs';
import {
  CreateMenuCategoryInputSchema,
  CreateUserInputSchema,
  DeleteUserInputSchema,
  UpdateMenuCategoryInputSchema,
  UpdateUserInputSchema,
} from '@shared/ipc';
import { salaryFromUser, salaryWriteData } from '@shared/staffSalary';
import { revokeSessionsForUser } from './services/ipcSession';
import { coreServices, withTableLock } from './services/core';
import { applyOpenAtLogin, isOpenAtLoginEnabled } from './services/hostRuntime';
import {
  dispatchTicket,
  fireDispatchTicket,
  paymentPrintWaitsForPrinters,
  pickActiveReceiptProfile,
  testPrintWithProfile,
} from './services/printDispatcher';
import {
  fiscalizePaymentOnce,
  flagVoidAfterFiscalization,
  getFiscalTokenHint,
  testFiscalConnection,
  testMinimalCloudInvoice,
} from './services/fiscal';
import { reportAuditWriteFailure } from './services/adminAlerts';
import { stripTransferTagsFromNote } from '@shared/utils/transferNote';
import * as reservationsService from './services/reservations';
import {
  assertDiningFloorEnabled,
  assertStaffRoleAllowed,
  assertStoreCounterAllowed,
  storePlanBlocksKds,
  storePlanBlocksReservations,
  storePlanBlocksTables,
  withLicenseEdition,
} from './services/license';
import {
  broadcastTicketsChanged,
  broadcastLayoutChanged,
  broadcastSettingsChanged,
  broadcastUsersChanged,
  ensureSseKeepAlive,
  sseCatchupIfMissed,
} from './services/realtime';
import { getFloorSnapshot } from './services/floorSnapshot';
import {
  asTicketLogItems,
  rowIsInOpenSession,
  ticketCreatedAtIso,
} from '@shared/ticketLogItems';
import { readTableMerges, writeTableMerges } from './services/tableMerges';
import { transferTableLocal } from './services/tableTransfer';
import { setTableOpenWithSideEffects } from './services/tableOpen';
import {
  closeTableAfterAcceptedPayment,
  closeTableAfterIdempotentPayment,
  isPaymentReprint,
  paymentPrintAccepted,
  paymentShouldCloseTable,
  tableAlreadyPaidResult,
  tableIsOpenForPayment,
  withPaymentLock,
} from './services/paymentSettle';
import { getTableTooltip, listPaidTablesForDay } from './services/tableTooltip';
import { createKdsTicketFromLog } from './services/kdsCreateTicket';
import { applyKdsVoidItem, applyKdsVoidTicket } from './services/kdsVoid';
import { ensureKdsLocalSchema } from './services/kdsSchema';
import { isClockOnlyRole } from '@shared/utils/roles';
import { isClockCaptureEnabled } from '@shared/clockCapture';
import { shiftReopenBlockedUntil } from '@shared/shiftReopen';
import { settingsChangeFromHost } from '@shared/settingsChange';
import { authorizeLanRoute } from './services/lanPolicy';
import {
  authorizeCreateUser,
  isFirstAdminLanBootstrap,
} from './services/createUserAuth';
import { syncTableAreasToDb } from './services/tableAreasSync';
import { presentSettingsForClient } from './services/settingsPresent';
import { getVaultPrefs, setVaultUnlockMode } from './services/vault/lifecycle';
import {
  createMenuItemFromInput,
  listMenuCategoriesForClient,
  updateMenuItemFromInput,
} from './services/menuAdmin';
import {
  listHostSystemPrinters,
  listLanIpv4Addresses,
} from './services/lanHost';
import {
  createDbBackupNow,
  listDbBackups,
  restoreDbBackup,
} from './services/dbBackups';
import {
  listFiscalReviewsForAdmin,
  resolveFiscalReviewForAdmin,
} from './services/fiscalReviews';
import { lanLoginRequiresPairingCode } from './services/lanLoginPairing';
import {
  listAdminTicketCounts,
  listAdminTicketsByUser,
} from './services/adminTickets';
import {
  eraseAllTickets,
  eraseTicketsConfirmMatches,
} from './services/eraseTickets';
import { isThisMachineAddress } from '@shared/localPosHost';
import os from 'node:os';
import {
  checkHostAndClients,
  downloadHostAndClients,
  getHostUpdateStatus,
  installHostAndClients,
} from './services/appUpdates';
import {
  logSecurityEvent,
  sanitizeString,
  validatePin,
} from './services/security';
import { allowLanCorsOrigin, isTrustedLanClient } from './services/lanCors';
import { planItemVoid, planTicketVoid } from '@shared/voidPaid';
import {
  gzipBodyIfAccepted,
  gzipHtmlIfAccepted,
  resolveStaticFilePath,
  staticAssetCacheControl,
} from './services/staticPath';
import { ifNoneMatchHits, weakEtag } from './services/lanConditional';
import { enforceAuthoritativePaymentTotals } from './services/paymentTotals';
import {
  ensureSettledSaleFromPrintJob,
  persistReceiptAudit,
} from './services/salesLedger';
import {
  buildSalesTrendBuckets,
  fetchPaidSales,
  fillTrendPoints,
  getAdminReview,
  sumPaidRevenue,
  topSellingFromSales,
} from './services/paidAnalytics';
import { app } from 'electron';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import {
  formatKdsTicketListRows,
  getKdsTicketDetail,
  listWaiterFloorOrders,
  notifyKdsTicketChanged,
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
import {
  findLatestTicketLogForCurrentSession,
  getCurrentSessionOwnerId,
  getCurrentTableSessionKey,
  getTableSessionStartedAt,
} from './services/tableSession';
import { compactTicketLogSession } from './services/ticketLogCompact';
import { compactCoversForTable } from './services/coversCompact';
import {
  finalizeShiftAfterClockOut,
  printMyDaySummary,
} from './services/shiftSummary';
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

/**
 * Waiter-hot JSON: gzip when asked, and optional ETag so a phone can
 * skip JSON.parse when occupancy / menu / kitchen board did not change.
 */
function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  code: number,
  data: any,
  corsOrigin?: string | null,
  opts?: { etag?: boolean },
) {
  setSecurityHeaders(res, corsOrigin || null);
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const contentType =
    typeof data === 'string'
      ? 'text/plain; charset=utf-8'
      : 'application/json; charset=utf-8';

  if (opts?.etag) {
    const tag = weakEtag(body);
    res.setHeader('ETag', tag);
    if (!res.getHeader('Cache-Control')) {
      res.setHeader('Cache-Control', 'private, no-cache');
    }
    if (code === 200 && ifNoneMatchHits(req.headers['if-none-match'], tag)) {
      res.writeHead(304);
      res.end();
      return;
    }
  }

  const packed = gzipBodyIfAccepted(
    Buffer.from(body),
    contentType,
    String(req.headers['accept-encoding'] || ''),
  );
  res.setHeader('Content-Type', contentType);
  if (packed.contentEncoding) {
    res.setHeader('Content-Encoding', packed.contentEncoding);
    res.setHeader('Vary', 'Accept-Encoding');
  }
  res.writeHead(code);
  res.end(packed.body);
}

function sendPlanError(
  res: http.ServerResponse,
  err: unknown,
  corsOrigin?: string | null,
) {
  const e = err as { statusCode?: number; message?: string };
  send(
    res,
    Number(e?.statusCode) || 403,
    { error: String(e?.message || err) },
    corsOrigin,
  );
}

function allowStoreCounterArea(
  area: unknown,
  res: http.ServerResponse,
  corsOrigin?: string | null,
): boolean {
  try {
    assertStoreCounterAllowed(area == null ? '' : String(area));
    return true;
  } catch (err) {
    sendPlanError(res, err, corsOrigin);
    return false;
  }
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

function lanStaffDto(u: {
  id: number;
  displayName: string;
  role: string;
  active: boolean;
  createdAt: Date | string;
  salaryAmount?: unknown;
  salaryPeriod?: unknown;
}) {
  const salary = salaryFromUser(u);
  return {
    id: u.id,
    displayName: u.displayName,
    role: u.role,
    active: u.active,
    createdAt:
      u.createdAt instanceof Date
        ? u.createdAt.toISOString()
        : String(u.createdAt),
    salaryAmount: salary.salaryAmount,
    salaryPeriod: salary.salaryPeriod,
  };
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

let sessionApiSecret: string | null = null;

async function getOrCreateApiSecret(): Promise<string> {
  try {
    const current = await coreServices.readSettings();
    const existing = (current as any)?.security?.apiSecret;
    if (typeof existing === 'string' && existing.length >= 32) return existing;
    const created = base64url(crypto.randomBytes(32));
    await coreServices.updateSettings({
      security: { ...(current as any)?.security, apiSecret: created },
    });
    sessionApiSecret = created;
    return created;
  } catch (e) {
    console.warn('[lan] api secret from DB failed:', e);
    if (!sessionApiSecret) sessionApiSecret = base64url(crypto.randomBytes(32));
    return sessionApiSecret;
  }
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

function pairingCodesMatch(provided: unknown, expected: string): boolean {
  const a = Buffer.from(String(provided || '').trim(), 'utf8');
  const b = Buffer.from(String(expected || '').trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function hostInterfaceAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni?.address) out.push(ni.address);
      }
    }
  } catch {
    // ignore
  }
  return out;
}

function isLoopback(remoteAddress: string | undefined) {
  // Same-machine Admin often hits http://192.168.x.x:3333, which is not
  // 127.0.0.1 — still this till, so pairing must not apply.
  return isThisMachineAddress(remoteAddress, hostInterfaceAddresses());
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

function createCorsPolicy(): CorsPolicy {
  const extra = (process.env.POS_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    allowOrigin(origin: string | undefined, hostHeader: string | undefined) {
      return allowLanCorsOrigin(origin, hostHeader, extra);
    },
  };
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
      'Content-Type, Authorization, Idempotency-Key, X-POS-Client, If-None-Match',
    );
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Encoding');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
    // Admin/KDS Vite (localhost) fetching a private LAN IP is a Chromium
    // Private Network Access request. Without this the preflight fails as
    // "Failed to fetch" even though Scan (main process) already found the till.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
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
  const cors = createCorsPolicy();

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
        if (!isLoopback(remoteIp) && !isTrustedLanClient(req, parsed, origin)) {
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
        // Every branch below goes through `resolveStaticFilePath`, which keeps
        // the result inside the renderer directory. These GETs are
        // unauthenticated, so an unchecked join would expose the whole disk.
        let filePath: string | null = '';
        if (
          pathname === '/' ||
          pathname === '/renderer' ||
          pathname === '/renderer/'
        ) {
          filePath = resolveStaticFilePath(RENDERER_DIR, 'index.html');
        } else if (pathname.startsWith('/renderer/')) {
          filePath = resolveStaticFilePath(
            RENDERER_DIR,
            pathname.slice('/renderer/'.length),
          );
        } else if (
          pathname === '/index.html' ||
          pathname.startsWith('/assets/') ||
          pathname.startsWith('/favicon')
        ) {
          filePath = resolveStaticFilePath(RENDERER_DIR, pathname);
        }
        if (filePath === null) {
          return send(res, 404, { error: 'not found' }, corsOrigin);
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
              const buf = Buffer.from(await upstream.arrayBuffer());
              const contentType =
                upstream.headers.get('content-type') ||
                getContentType(upstreamPath);
              const packed = gzipHtmlIfAccepted(
                buf,
                contentType,
                req.headers['accept-encoding'],
              );
              const headers: Record<string, string> = {
                'Content-Type': contentType,
                'Cache-Control': staticAssetCacheControl(upstreamPath),
                'Content-Length': String(packed.body.length),
              };
              if (packed.contentEncoding) {
                headers['Content-Encoding'] = packed.contentEncoding;
                headers.Vary = 'Accept-Encoding';
              }
              if (corsOrigin)
                headers['Access-Control-Allow-Origin'] = corsOrigin;
              res.writeHead(upstream.status, headers);
              res.end(packed.body);
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
            const contentType = getContentType(filePath);
            const headers: Record<string, string> = {
              'Content-Type': contentType,
              'Cache-Control': staticAssetCacheControl(filePath),
            };
            if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
            if (contentType.includes('text/html')) {
              const packed = gzipHtmlIfAccepted(
                fs.readFileSync(filePath),
                contentType,
                req.headers['accept-encoding'],
              );
              headers['Content-Length'] = String(packed.body.length);
              if (packed.contentEncoding) {
                headers['Content-Encoding'] = packed.contentEncoding;
                headers.Vary = 'Accept-Encoding';
              }
              res.writeHead(200, headers);
              res.end(packed.body);
              return;
            }
            const stream = fs.createReadStream(filePath);
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
        res.write('retry: 2000\n\n');
        const lastEventHeader = req.headers['last-event-id'];
        const lastEventQuery = parsed.query.lastEventId;
        const lastEventRaw = Array.isArray(lastEventHeader)
          ? lastEventHeader[0]
          : lastEventHeader ||
            (Array.isArray(lastEventQuery)
              ? lastEventQuery[0]
              : lastEventQuery) ||
            '';
        const lastEventId = Number(lastEventRaw);
        const catchup = sseCatchupIfMissed(lastEventId);
        if (catchup) res.write(catchup);
        const client = { res } as any;
        (globalThis as any).__SSE_CLIENTS__ =
          (globalThis as any).__SSE_CLIENTS__ || new Set();
        const clients: Set<any> = (globalThis as any).__SSE_CLIENTS__;
        clients.add(client);
        ensureSseKeepAlive();
        req.on('close', () => clients.delete(client));
        return;
      }

      // PIN screen on iOS/Android has no JWT yet. Same staff names as
      // GET /auth/users, live, without exposing tables/tickets.
      if (req.method === 'GET' && pathname === '/events/login') {
        setSecurityHeaders(res, corsOrigin || null);
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; connect-src 'self'",
        );
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.writeHead(200);
        res.write('retry: 2000\n\n');
        const client = { res } as any;
        (globalThis as any).__SSE_LOGIN_CLIENTS__ =
          (globalThis as any).__SSE_LOGIN_CLIENTS__ || new Set();
        const loginClients: Set<any> = (globalThis as any)
          .__SSE_LOGIN_CLIENTS__;
        loginClients.add(client);
        ensureSseKeepAlive();
        req.on('close', () => loginClients.delete(client));
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        res.setHeader('Cache-Control', 'no-store');
        return send(
          res,
          200,
          {
            ok: true,
            t: Date.now(),
            appVersion: app.getVersion(),
          },
          corsOrigin,
        );
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
          if (!lanEnabled && !isTrustedLanClient(req, parsed, origin))
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
          if (!pairingCodesMatch(pairingCode, code))
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
        // code requirement for staff devices.
        const { pin, userId, pairingCode } = await parseJson(req);
        const remoteIp = (req.socket as any)?.remoteAddress;
        let requirePairing = false;
        // If this is a LAN client (not loopback), gate web access first.
        // Pairing is checked after the PIN so Admin — the issuer of the
        // code — can sign in without typing its own invite.
        try {
          const s = await coreServices.readSettings();
          requirePairing = Boolean((s as any)?.security?.requirePairingCode);
          const lanEnabled =
            Boolean((s as any)?.security?.allowLan) ||
            process.env.POS_ALLOW_LAN === 'true';
          // Native app bypasses the browser-only "Allow Web access" gate,
          // but the pairing-code check below still applies to staff when
          // pairing is required.
          const gateForBrowsers =
            lanEnabled || isTrustedLanClient(req, parsed, origin);
          if (!gateForBrowsers && !isLoopback(remoteIp)) {
            return send(res, 403, { error: 'web access disabled' }, corsOrigin);
          }
        } catch {
          // fail closed for LAN clients if we can't read settings
          if (!isLoopback(remoteIp)) {
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
        if (
          lanLoginRequiresPairingCode({
            requirePairing,
            loopback: isLoopback(remoteIp),
            role: user.role,
          })
        ) {
          const code = await getOrCreatePairingCode();
          if (!pairingCodesMatch(pairingCode, code)) {
            return send(
              res,
              403,
              { error: 'pairing code required' },
              corsOrigin,
            );
          }
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
        '/events/login',
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
        '/health',
      ]);
      const isPublic = publicPaths.has(pathname) || isStaticGet;
      const createUserCount =
        req.method === 'POST' && pathname === '/auth/create-user'
          ? await prisma.user.count().catch(() => -1)
          : undefined;
      const firstAdminBootstrap = isFirstAdminLanBootstrap(
        req.method || 'GET',
        pathname,
        createUserCount ?? -1,
      );
      let auth: AuthContext = null;
      if (!isPublic) {
        const token = pickBearerToken(req, parsed);
        auth = token ? await verifyToken(secret, token) : null;
        // Empty database: OneTap Admin has no JWT yet. Ignore leftover tokens
        // from a previous till so clock-only / role checks cannot 401/403 the
        // bootstrap admin create.
        if (firstAdminBootstrap) {
          auth = null;
        } else if (!auth) {
          return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        }
      } else if (pathname === '/settings') {
        // Public locale/currency read, but an admin bearer may also fetch
        // credentials such as the pairing code — same rule as IPC settings:get.
        const token = pickBearerToken(req, parsed);
        if (token) auth = await verifyToken(secret, token);
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
          { userCount: createUserCount },
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
        const reservationsOnThisPlan = !storePlanBlocksReservations();
        const isHostReservationsPath =
          (role === 'HOST' || role === 'ADMIN') &&
          (pathname === '/auth/users' ||
            pathname === '/settings' ||
            pathname === '/auth/verify-manager-pin' ||
            pathname === '/tables/open' ||
            pathname === '/tickets/tooltip' ||
            pathname === '/tickets/paid-tables' ||
            (reservationsOnThisPlan && pathname.startsWith('/reservations')) ||
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
        res.setHeader('Cache-Control', 'private, no-cache');
        try {
          const token = pickBearerToken(req, parsed);
          const menuAuth = token ? await verifyToken(secret, token) : auth;
          const role = String(menuAuth?.role || '').toUpperCase();
          const adminMenu = role === 'ADMIN';
          return sendJson(
            req,
            res,
            200,
            await listMenuCategoriesForClient({
              includeCost: adminMenu || role === 'CASHIER',
              includeInactiveItems: adminMenu,
            }),
            corsOrigin,
            { etag: true },
          );
        } catch (e: any) {
          return send(
            res,
            500,
            { error: String(e?.message || e || 'menu failed') },
            corsOrigin,
          );
        }
      }

      if (req.method === 'POST' && pathname === '/menu/create-category') {
        try {
          const input = CreateMenuCategoryInputSchema.parse(
            await parseJson(req),
          );
          const created = await prisma.category.create({
            data: {
              name: input.name.trim(),
              sortOrder: Number(input.sortOrder ?? 0),
              active: input.active ?? true,
              color: (input as any).color ?? null,
              kdsStation: (input as any).kdsStation ?? null,
            } as any,
          });
          return send(res, 200, { id: created.id }, corsOrigin);
        } catch (e: any) {
          return send(
            res,
            400,
            { error: String(e?.message || e || 'create failed') },
            corsOrigin,
          );
        }
      }
      if (req.method === 'POST' && pathname === '/menu/update-category') {
        try {
          const input = UpdateMenuCategoryInputSchema.parse(
            await parseJson(req),
          );
          const data: any = {
            ...(typeof input.name === 'string'
              ? { name: input.name.trim() }
              : {}),
            ...(typeof input.sortOrder === 'number'
              ? { sortOrder: input.sortOrder }
              : {}),
            ...((input as any).color !== undefined
              ? { color: (input as any).color }
              : {}),
            ...(typeof input.active === 'boolean'
              ? { active: input.active }
              : {}),
            ...((input as any).kdsStation !== undefined
              ? { kdsStation: (input as any).kdsStation }
              : {}),
          };
          await prisma.category.update({ where: { id: input.id }, data });
          if ((input as any).kdsStation) {
            await prisma.menuItem.updateMany({
              where: { categoryId: input.id },
              data: { station: (input as any).kdsStation },
            });
          }
          return send(res, 200, true, corsOrigin);
        } catch (e: any) {
          return send(
            res,
            400,
            { error: String(e?.message || e || 'update failed') },
            corsOrigin,
          );
        }
      }
      if (req.method === 'POST' && pathname === '/menu/delete-category') {
        const id = Number((await parseJson(req))?.id || 0);
        if (!id) return send(res, 400, { error: 'invalid id' }, corsOrigin);
        await prisma.category
          .update({ where: { id }, data: { active: false } as any })
          .catch(() => null);
        await prisma.menuItem
          .updateMany({
            where: { categoryId: id },
            data: { active: false } as any,
          })
          .catch(() => null);
        return send(res, 200, true, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/menu/create-item') {
        try {
          const created = await createMenuItemFromInput(await parseJson(req));
          return send(res, 200, created, corsOrigin);
        } catch (e: any) {
          return send(
            res,
            400,
            { error: String(e?.message || e || 'create failed') },
            corsOrigin,
          );
        }
      }
      if (req.method === 'POST' && pathname === '/menu/update-item') {
        try {
          await updateMenuItemFromInput(await parseJson(req));
          return send(res, 200, true, corsOrigin);
        } catch (e: any) {
          return send(
            res,
            400,
            { error: String(e?.message || e || 'update failed') },
            corsOrigin,
          );
        }
      }
      if (req.method === 'POST' && pathname === '/menu/delete-item') {
        const id = Number((await parseJson(req))?.id || 0);
        if (!id) return send(res, 400, { error: 'invalid id' }, corsOrigin);
        await prisma.menuItem
          .update({ where: { id }, data: { active: false } as any })
          .catch(() => null);
        return send(res, 200, true, corsOrigin);
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
        if (!allowStoreCounterArea(sanitizedArea, res, corsOrigin)) return;
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

            // Same cumulative-snapshot tagging as the Electron IPC path —
            // see `getCurrentTableSessionKey`.
            const sessionKey = await getCurrentTableSessionKey(
              sanitizedArea,
              sanitizedTableLabel,
            ).catch(() => null);

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
                  ...(sessionKey ? { sessionKey } : {}),
                } as any,
              });
            } catch (e: any) {
              if (e?.code === 'P2002' && idempotencyKey) {
                return { ok: true as const };
              }
              throw e;
            }
            return {
              ok: true as const,
              written: true as const,
              sessionKey,
            };
          },
        );

        if (!result.ok) {
          // `permanent` tells the client's offline queue that a retry cannot
          // change this outcome. Without it a LAN client treated a closed or
          // re-owned table as a transport blip and replayed the order forever.
          return send(res, 409, { ...result, permanent: true }, corsOrigin);
        }

        if ('written' in result && result.written) {
          try {
            broadcastTicketsChanged({
              area: sanitizedArea,
              tableLabel: sanitizedTableLabel,
              userId: Number(userId),
            });
          } catch (e) {
            void e;
          }
          void compactTicketLogSession(result.sessionKey);
          if (!storePlanBlocksKds()) {
            const kdsFireItems = Array.isArray(body?.kdsFireItems)
              ? body.kdsFireItems
              : undefined;
            void createKdsTicketFromLog({
              userId: Number(userId),
              area: sanitizedArea,
              tableLabel: sanitizedTableLabel,
              items: items ?? [],
              fireItems: kdsFireItems,
              note: sanitizedNote,
              courseLabel:
                typeof body?.kdsCourseLabel === 'string'
                  ? body.kdsCourseLabel
                  : null,
            }).catch(() => undefined);
          }
        }
        return send(res, 201, { ok: true }, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/tickets/latest') {
        const area = String(parsed.query.area || '');
        const tableLabel = String(parsed.query.table || '');
        if (!area || !tableLabel) return send(res, 400, 'invalid', corsOrigin);
        // Current sitting only. An unoccupied table has no bill.
        const last = await findLatestTicketLogForCurrentSession(
          area,
          tableLabel,
        );
        if (!last) {
          return send(res, 200, null, corsOrigin);
        }
        const items = asTicketLogItems(last.itemsJson);
        return send(
          res,
          200,
          {
            items,
            note: stripTransferTagsFromNote(last.note) || null,
            covers: last.covers ?? null,
            createdAt: ticketCreatedAtIso(last.createdAt),
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
      // Store tills have no kitchen; keep /kds/debug as a LAN reachability ping.
      if (
        pathname.startsWith('/kds') &&
        pathname !== '/kds/debug' &&
        storePlanBlocksKds()
      ) {
        return send(
          res,
          403,
          { error: 'Kitchen display is not available on the Store plan.' },
          corsOrigin,
        );
      }

      if (storePlanBlocksTables()) {
        if (
          pathname === '/tables/transfer' ||
          pathname === '/tables/floor-snapshot' ||
          pathname.startsWith('/layout') ||
          pathname.startsWith('/requests')
        ) {
          try {
            assertDiningFloorEnabled();
          } catch (err) {
            return sendPlanError(res, err, corsOrigin);
          }
        }
      }

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
      if (req.method === 'GET' && pathname === '/kds/floor-orders') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const settings: any = await coreServices
          .readSettings()
          .catch(() => ({}));
        if (!kdsMasterEnabledFromSettings(settings)) {
          return send(res, 200, [], corsOrigin);
        }
        const stations = Array.from(enabledStationsFromSettings(settings));
        const out = await listWaiterFloorOrders(stations, {
          waiterUserId: Number(auth?.userId || 0),
        });
        return sendJson(req, res, 200, out, corsOrigin, { etag: true });
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
          .findUnique({
            where: { id },
            include: { order: true },
          })
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
            notifyKdsTicketChanged(ticket);
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
          notifyKdsTicketChanged(ticket);
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
        if (ticket) notifyKdsTicketChanged(ticket);
        return send(res, 200, { ok: Boolean(updated?.count) }, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/kds/recall') {
        const ok = await ensureKdsLocalSchema();
        if (!ok) return send(res, 503, { error: 'kds not ready' }, corsOrigin);
        const { station, ticketId, itemIdx, cooker } = await parseJson(req);
        const result = await recallKdsTicket(prisma, {
          station: String(station || 'KITCHEN'),
          ticketId,
          itemIdx,
          cooker: Boolean(cooker),
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
          .findUnique({
            where: { id },
            include: { order: true },
          })
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
          notifyKdsTicketChanged(ticket);
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
        notifyKdsTicketChanged(ticket);
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
      if (req.method === 'POST' && pathname === '/print/test-profile') {
        const body = await parseJson(req);
        const profile = (body as any)?.profile ?? body;
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
          return send(
            res,
            400,
            { ok: false, error: 'Missing printer profile.' },
            corsOrigin,
          );
        }
        const settings = await coreServices.readSettings();
        const r = await testPrintWithProfile(profile as any, settings as any);
        return send(
          res,
          r.ok ? 200 : 500,
          { ok: r.ok, error: r.error },
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/print/scan-network') {
        try {
          const { scanNetworkPrinters } = await import(
            './services/networkPrinterScan'
          );
          const rows = await scanNetworkPrinters();
          return send(res, 200, Array.isArray(rows) ? rows : [], corsOrigin);
        } catch (e: any) {
          console.warn('[lan] printer scan failed:', e?.message || e);
          return send(res, 200, [], corsOrigin);
        }
      }
      if (req.method === 'GET' && pathname === '/print/list') {
        return send(res, 200, await listHostSystemPrinters(), corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/print/serial-ports') {
        try {
          const { listSerialPorts } = await import('./serial');
          return send(res, 200, await listSerialPorts(), corsOrigin);
        } catch (e: any) {
          console.warn('[lan] listSerialPorts failed:', e?.message || e);
          return send(res, 200, [], corsOrigin);
        }
      }
      if (req.method === 'GET' && pathname === '/network/ips') {
        return send(res, 200, listLanIpv4Addresses(), corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/backups') {
        return send(res, 200, listDbBackups(), corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/backups/create') {
        return send(res, 200, await createDbBackupNow(), corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/backups/restore') {
        const body = await parseJson(req);
        return send(
          res,
          200,
          await restoreDbBackup(String(body?.name || '')),
          corsOrigin,
        );
      }
      if (req.method === 'GET' && pathname === '/vault/prefs') {
        return send(res, 200, getVaultPrefs(), corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/vault/prefs') {
        const body = await parseJson(req);
        const unlockMode =
          body?.unlockMode === 'passphrase' ? 'passphrase' : 'os';
        const result = await setVaultUnlockMode({
          unlockMode,
          passphrase: body?.passphrase ? String(body.passphrase) : undefined,
        });
        if (!result.ok) {
          return send(res, 200, result, corsOrigin);
        }
        return send(res, 200, { ok: true, ...getVaultPrefs() }, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/settings/fiscal-token-hint') {
        const settings = await coreServices.readSettings();
        return send(res, 200, getFiscalTokenHint(settings as any), corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/settings/fiscal-test') {
        const settings = await coreServices.readSettings();
        return send(
          res,
          200,
          await testFiscalConnection(settings as any),
          corsOrigin,
        );
      }
      if (
        req.method === 'POST' &&
        pathname === '/settings/fiscal-test-minimal'
      ) {
        const settings = await coreServices.readSettings();
        return send(
          res,
          200,
          await testMinimalCloudInvoice(settings as any),
          corsOrigin,
        );
      }
      if (req.method === 'GET' && pathname === '/settings/fiscal-reviews') {
        return send(res, 200, await listFiscalReviewsForAdmin(), corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/settings/fiscal-reviews') {
        const body = await parseJson(req);
        const result = await resolveFiscalReviewForAdmin(body);
        if (result.ok) {
          logSecurityEvent('fiscal_review_resolved', {
            userId: auth?.userId,
            idempotencyKey: String(body?.idempotencyKey || ''),
            resolution: String(body?.resolution || ''),
          });
        }
        return send(res, 200, result, corsOrigin);
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
          if (existing) {
            await ensureSettledSaleFromPrintJob(existing as any).catch(
              () => null,
            );
            const closed = await closeTableAfterIdempotentPayment(
              String(body?.area || ''),
              String(body?.tableLabel || ''),
              String(
                body?.meta?.kind ||
                  (existing as any)?.payloadJson?.meta?.kind ||
                  '',
              ),
              paymentShouldCloseTable(
                (existing as any)?.payloadJson?.meta ?? body?.meta,
              ),
            );
            return send(res, 200, closed, corsOrigin);
          }
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
        const payKindHint = String(requested?.meta?.kind || '').toUpperCase();
        const runLanPrint = async () => {
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
          let fiscalPending:
            | { fiscalPending: true; fiscalMessage?: string }
            | undefined;
          const payKind = String(payload?.meta?.kind || '').toUpperCase();
          if (payKind === 'PAYMENT' && !isPaymentReprint(payload?.meta)) {
            if (
              !(await tableIsOpenForPayment(payload.area, payload.tableLabel))
            ) {
              return send(res, 409, tableAlreadyPaidResult(), corsOrigin);
            }
            const outcome = await fiscalizePaymentOnce(
              payload,
              settings as any,
              {
                idempotencyKey: printIdempotencyKey || undefined,
              },
            );
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
            if (outcome.kind === 'retryable') {
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
            if (outcome.kind === 'deferred') {
              fiscalPending = {
                fiscalPending: true,
                fiscalMessage: outcome.message,
              };
            }
            fiscalPayload = outcome.payload;
          }

          // Single dispatch: hands off mode selection, profile picking,
          // and ORDER/category routing to `printDispatcher`. Used to be
          // ~150 lines of mode branching here; moving it out also fixed
          // the iOS routing gap (this HTTP route now respects per-station
          // / per-category printer assignments, just like the Electron
          // path does).
          const persistLanAudit = async (status: 'SENT' | 'FAILED') => {
            try {
              await persistReceiptAudit({
                payload: fiscalPayload,
                idempotencyKey: printIdempotencyKey || undefined,
                status,
                settings,
              });
            } catch (e: any) {
              // P2002 = a concurrent identical payment won the race; its row
              // is the audit record and this one is a duplicate.
              if (!(e?.code === 'P2002' && printIdempotencyKey)) {
                // Without this row the payment is absent from the sales ledger
                // and receipt history, and if it was fiscalized the tax
                // service holds an invoice this POS cannot show.
                await reportAuditWriteFailure({
                  area: String(body?.area || ''),
                  tableLabel: String(body?.tableLabel || ''),
                  actorUserId: Number(body?.meta?.userId || 0) || undefined,
                  error: String(e?.message || e),
                });
              }
            }
          };

          const dispatchOpts = { persistRetryOnTransientFailure: true };

          if (paymentPrintWaitsForPrinters(payKind)) {
            const r = await dispatchTicket(
              fiscalPayload,
              settings as any,
              dispatchOpts,
            );
            await persistLanAudit(r.ok ? 'SENT' : 'FAILED');
            const closeTable = paymentShouldCloseTable(payload?.meta);
            if (closeTable) {
              await closeTableAfterAcceptedPayment(
                payload.area,
                payload.tableLabel,
              );
            }
            return send(
              res,
              200,
              paymentPrintAccepted(r.ok, closeTable, fiscalPending),
              corsOrigin,
            );
          }

          // Kitchen Send must not sit on TCP to every printer before the
          // tablet gets 200. Claim the idempotency key, then print in the
          // background; a down printer retries via the station loop.
          await persistLanAudit('SENT');
          fireDispatchTicket(fiscalPayload, settings as any, dispatchOpts);
          return send(res, 200, { ok: true }, corsOrigin);
        };

        if (payKindHint === 'PAYMENT') {
          return withPaymentLock(
            requested.area,
            requested.tableLabel,
            runLanPrint,
          );
        }
        return runLanPrint();
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

        // Settled money is beyond a waiter's reach — only an admin
        // correction can undo a paid (and filed) line. Refuse before the
        // audit notification, so the log never claims a void that the
        // ticket did not take.
        const last = await findLatestTicketLogForCurrentSession(
          String(area),
          String(tableLabel),
        );
        const plan = planItemVoid((last?.itemsJson as any[]) || [], item);
        if (plan.outcome === 'paid') {
          return send(res, 409, { error: 'line_already_paid' }, corsOrigin);
        }

        const message = `Voided item on ${area} ${tableLabel}: ${item.name} x${Number(item.qty || 1)}${approvedByAdminId ? ` (approved by: ${String(approvedByAdminName || `admin#${approvedByAdminId}`)})` : ''}`;
        await prisma.notification
          .create({
            data: { userId: Number(userId), type: 'OTHER' as any, message },
          })
          .catch(() => {});
        if (last && plan.outcome === 'ok') {
          const items = (last.itemsJson as any[]) || [];
          items[plan.index] = { ...items[plan.index], voided: true };
          await prisma.ticketLog.update({
            where: { id: last.id },
            data: { itemsJson: items },
          });
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

        // Paid lines stay on the ticket. When they are all that is left,
        // this sitting is settled and only an admin correction can reverse
        // it — mirrors the desktop `tickets:voidTicket` rule.
        const last = await findLatestTicketLogForCurrentSession(
          String(area),
          String(tableLabel),
        );
        const plan = planTicketVoid((last?.itemsJson as any[]) || []);
        if (plan.outcome === 'paid') {
          return send(res, 409, { error: 'ticket_already_paid' }, corsOrigin);
        }

        const message = `Voided ticket on ${area} ${tableLabel}${reason ? `: ${reason}` : ''}${approvedByAdminId ? ` (approved by: ${String(approvedByAdminName || `admin#${approvedByAdminId}`)})` : ''}`;
        await prisma.notification
          .create({
            data: { userId: Number(userId), type: 'OTHER' as any, message },
          })
          .catch(() => {});
        if (last) {
          await prisma.ticketLog.update({
            where: { id: last.id },
            data: {
              itemsJson: plan.items,
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
        await applyKdsVoidTicket({
          userId: Number(userId),
          area: String(area),
          tableLabel: String(tableLabel),
          reason: reason ? String(reason) : undefined,
        }).catch(() => false);
        await setTableOpenWithSideEffects(
          String(area),
          String(tableLabel),
          false,
        ).catch(() => false);
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
        if (!allowStoreCounterArea(area, res, corsOrigin)) return;
        const ok = await setTableOpenWithSideEffects(
          String(area),
          String(label),
          Boolean(open),
        );
        if (!ok) return send(res, 400, 'invalid', corsOrigin);
        return send(res, 200, 'ok', corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/tables/open') {
        return sendJson(
          req,
          res,
          200,
          await coreServices.listOpenTables(),
          corsOrigin,
          { etag: true },
        );
      }
      if (req.method === 'GET' && pathname === '/tables/floor-snapshot') {
        const area = String(parsed.query.area || '').trim();
        const snap = await getFloorSnapshot(area || undefined);
        res.setHeader(
          'Cache-Control',
          'private, max-age=2, stale-while-revalidate=10',
        );
        return sendJson(req, res, 200, snap, corsOrigin, { etag: true });
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
        const suffix = `:${area}`;
        const candidates = await prisma.syncState
          .findMany({
            where: { key: { endsWith: suffix } as any } as any,
            orderBy: { updatedAt: 'desc' } as any,
            take: 20,
          })
          .catch(() => [] as any[]);
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
        const settings = await coreServices.readSettings().catch(() => null);
        if (!isClockCaptureEnabled(settings))
          return send(res, 200, null, corsOrigin);

        const lastClosed = await prisma.dayShift.findFirst({
          where: { openedById: Number(userId), closedAt: { not: null } },
          orderBy: { closedAt: 'desc' },
          select: { closedAt: true },
        });
        const reopenAt = shiftReopenBlockedUntil(
          settings,
          lastClosed?.closedAt,
        );
        if (reopenAt) {
          return send(
            res,
            200,
            {
              ok: false,
              code: 'SHIFT_REOPEN_BLOCKED',
              error: 'Shift reopen is blocked until the cooldown ends.',
              reopenAt: reopenAt.toISOString(),
            },
            corsOrigin,
          );
        }

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
            const keys = await coreServices.listOpenTables();
            for (const { area, label } of keys) {
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
            userId: n.userId,
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
        res.setHeader('Cache-Control', 'private, no-cache');
        const base = await coreServices.readSettings();
        const presented = await presentSettingsForClient(
          base as Record<string, any>,
          { includePairingCode: auth?.role === 'ADMIN' },
        );
        const result = withLicenseEdition({
          ...presented,
        } as Record<string, unknown>) as any;
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
          if (Array.isArray(input?.tableAreas)) {
            await syncTableAreasToDb(input.tableAreas);
          }
          if (
            input?.host &&
            Object.prototype.hasOwnProperty.call(input.host, 'openAtLogin')
          ) {
            applyOpenAtLogin(isOpenAtLoginEnabled(merged));
          }
          const presented = await presentSettingsForClient(
            merged as Record<string, any>,
            { includePairingCode: auth?.role === 'ADMIN' },
          );
          const result = withLicenseEdition({
            ...presented,
          } as Record<string, unknown>) as any;
          try {
            broadcastSettingsChanged(settingsChangeFromHost(merged));
          } catch {
            // tablets still pick this up on the next catchup
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
        if (!allowStoreCounterArea(area, res, corsOrigin)) return;
        await prisma.covers.create({
          data: { area: String(area), label: String(label), covers: num },
        });
        await compactCoversForTable(String(area), String(label));
        return send(res, 200, 'ok', corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/covers/last') {
        const area = String(parsed.query.area || '');
        const label = String(parsed.query.label || '');
        if (!area || !label) return send(res, 400, 'invalid', corsOrigin);
        const sessionStart = await getTableSessionStartedAt(area, label);
        if (!sessionStart) return send(res, 200, null, corsOrigin);
        const sqlHit = await prisma.covers
          .findFirst({
            where: { area, label, createdAt: { gte: sessionStart } },
            orderBy: { id: 'desc' },
          })
          .catch(() => null);
        if (sqlHit) return send(res, 200, sqlHit.covers ?? null, corsOrigin);
        const recent = await prisma.covers.findMany({
          where: { area, label },
          orderBy: { id: 'desc' },
          take: 20,
        });
        const row = recent.find(
          (r: { createdAt: Date; covers?: number | null }) =>
            rowIsInOpenSession(r.createdAt, sessionStart.getTime()),
        );
        return send(res, 200, row?.covers ?? null, corsOrigin);
      }

      // Admin overview and trends
      if (req.method === 'GET' && pathname === '/admin/overview') {
        const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
        const todayEnd = new Date(new Date().setHours(23, 59, 59, 999));
        const [users, openShifts, openTables, sales] = await Promise.all([
          prisma.user.count({ where: { active: true } }),
          prisma.dayShift.count({ where: { closedAt: null } }),
          coreServices.countOpenTables().catch(() => 0),
          fetchPaidSales({ from: todayStart, to: todayEnd }),
        ]);
        const settings = await coreServices.readSettings();
        const fiscalVatEnabled = isVatEnabledFromSettings(settings);
        const { revenueNet: revenueTodayNet, revenueVat: revenueTodayVat } =
          sumPaidRevenue(sales, { vatEnabled: fiscalVatEnabled });
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
        const trendRange =
          range === 'weekly' || range === 'monthly' ? range : 'daily';
        const buckets = buildSalesTrendBuckets(trendRange);
        const sales = await fetchPaidSales({
          from: buckets[0].from,
          to: buckets[buckets.length - 1].to,
        });
        return send(
          res,
          200,
          { range: trendRange, points: fillTrendPoints(sales, buckets) },
          corsOrigin,
        );
      }
      if (req.method === 'GET' && pathname === '/admin/users') {
        const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
        return send(res, 200, users.map(lanStaffDto), corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/admin/shifts') {
        const where: any = {};
        if (parsed.query.startIso || parsed.query.endIso) {
          where.openedAt = {};
          if (parsed.query.startIso)
            where.openedAt.gte = new Date(String(parsed.query.startIso));
          if (parsed.query.endIso)
            where.openedAt.lte = new Date(String(parsed.query.endIso));
        }
        const rows = await prisma.dayShift
          .findMany({
            where,
            orderBy: { openedAt: 'desc' },
            include: { openedBy: true, closedBy: true },
          } as any)
          .catch(() => []);
        return send(
          res,
          200,
          rows.map((r: any) => {
            const end = r.closedAt ? new Date(r.closedAt) : new Date();
            const start = new Date(r.openedAt);
            const durationMs = Math.max(0, end.getTime() - start.getTime());
            const durationHours = Math.round((durationMs / 36e5) * 100) / 100;
            return {
              id: r.id,
              userId: r.openedById,
              userName: r.openedBy?.displayName ?? `#${r.openedById}`,
              openedAt: r.openedAt.toISOString(),
              closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
              durationHours,
              isOpen: !r.closedAt,
            };
          }),
          corsOrigin,
        );
      }
      if (req.method === 'POST' && pathname === '/admin/erase-tickets') {
        const body = await parseJson(req);
        if (!eraseTicketsConfirmMatches(body?.confirm)) {
          return send(
            res,
            200,
            { ok: false, error: 'confirm-required' },
            corsOrigin,
          );
        }
        const result = await eraseAllTickets();
        logSecurityEvent('tickets_erased', {
          userId: auth?.userId,
          ticketLogs: result.ticketLogs,
          orders: result.orders,
        });
        return send(res, 200, result, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/admin/ticket-counts') {
        const rows = await listAdminTicketCounts({
          startIso: parsed.query.startIso
            ? String(parsed.query.startIso)
            : undefined,
          endIso: parsed.query.endIso ? String(parsed.query.endIso) : undefined,
        });
        return send(res, 200, rows, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/admin/tickets-by-user') {
        const rows = await listAdminTicketsByUser({
          userId: Number(parsed.query.userId),
          startIso: parsed.query.startIso
            ? String(parsed.query.startIso)
            : undefined,
          endIso: parsed.query.endIso ? String(parsed.query.endIso) : undefined,
        });
        return send(res, 200, rows, corsOrigin);
      }
      if (req.method === 'GET' && pathname === '/admin/top-selling-today') {
        const start = new Date(new Date().setHours(0, 0, 0, 0));
        const end = new Date(new Date().setHours(23, 59, 59, 999));
        const sales = await fetchPaidSales({ from: start, to: end });
        return send(res, 200, topSellingFromSales(sales), corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/admin/review') {
        try {
          const input = await parseJson(req);
          const data = await getAdminReview(input);
          return send(res, 200, data, corsOrigin);
        } catch (e: any) {
          return send(
            res,
            400,
            { error: String(e?.message || e || 'review failed') },
            corsOrigin,
          );
        }
      }
      if (req.method === 'GET' && pathname === '/admin/updates/status') {
        return send(res, 200, getHostUpdateStatus(), corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/admin/updates/check') {
        const result = await checkHostAndClients();
        return send(res, 200, result, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/admin/updates/download') {
        const result = await downloadHostAndClients();
        return send(res, 200, result, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/admin/updates/install') {
        const result = await installHostAndClients();
        return send(res, 200, result, corsOrigin);
      }
      if (req.method === 'POST' && pathname === '/auth/create-user') {
        try {
          const input = CreateUserInputSchema.parse(await parseJson(req));
          if (input.pin) {
            const pinValidation = validatePin(input.pin);
            if (!pinValidation.valid) {
              return send(
                res,
                400,
                { error: pinValidation.error || 'Invalid PIN format' },
                corsOrigin,
              );
            }
          }
          const sanitizedDisplayName = sanitizeString(input.displayName, 80);
          if (!sanitizedDisplayName) {
            return send(
              res,
              400,
              { error: 'Display name is required' },
              corsOrigin,
            );
          }
          const userCount = await prisma.user.count().catch(() => 0);
          const createAuth = authorizeCreateUser({
            userCount,
            sessionRole: auth?.role,
            requestedRole: input.role,
          });
          if (!createAuth.allow) {
            return send(res, 403, { error: 'forbidden' }, corsOrigin);
          }
          assertStaffRoleAllowed(input.role);
          const pinHash = await bcrypt.hash(input.pin, 10);
          const salary = salaryWriteData(
            input.salaryAmount ?? null,
            input.salaryPeriod ?? null,
          );
          const created = await prisma.user.create({
            data: {
              displayName: sanitizedDisplayName,
              role: input.role,
              pinHash,
              active: input.active ?? true,
              salaryAmount: salary.salaryAmount,
              salaryPeriod: salary.salaryPeriod,
            },
          });
          broadcastUsersChanged({ kind: 'created', id: created.id });
          return send(res, 200, lanStaffDto(created), corsOrigin);
        } catch (e: any) {
          const status = Number(e?.statusCode) === 403 ? 403 : 400;
          return send(
            res,
            status,
            { error: String(e?.message || e || 'create failed') },
            corsOrigin,
          );
        }
      }
      if (req.method === 'POST' && pathname === '/auth/update-user') {
        try {
          const input = UpdateUserInputSchema.parse(await parseJson(req));
          if (input.pin) {
            const pinValidation = validatePin(input.pin);
            if (!pinValidation.valid) {
              return send(
                res,
                400,
                { error: pinValidation.error || 'Invalid PIN format' },
                corsOrigin,
              );
            }
          }
          const sanitizedInput: any = { ...input };
          if (input.displayName) {
            const sanitized = sanitizeString(input.displayName, 80);
            if (!sanitized) {
              return send(
                res,
                400,
                { error: 'Display name cannot be empty' },
                corsOrigin,
              );
            }
            sanitizedInput.displayName = sanitized;
          }
          if (sanitizedInput.role) assertStaffRoleAllowed(sanitizedInput.role);
          let pinHash: string | undefined;
          if (sanitizedInput.pin)
            pinHash = await bcrypt.hash(sanitizedInput.pin, 10);
          const salaryPatch =
            input.salaryAmount !== undefined || input.salaryPeriod !== undefined
              ? salaryWriteData(
                  input.salaryAmount ?? null,
                  input.salaryPeriod ?? null,
                )
              : null;
          const updated = await prisma.user.update({
            where: { id: input.id },
            data: {
              ...(sanitizedInput.displayName
                ? { displayName: sanitizedInput.displayName }
                : {}),
              ...(sanitizedInput.role ? { role: sanitizedInput.role } : {}),
              ...(typeof sanitizedInput.active === 'boolean'
                ? { active: sanitizedInput.active }
                : {}),
              ...(pinHash ? { pinHash } : {}),
              ...(salaryPatch
                ? {
                    salaryAmount: salaryPatch.salaryAmount,
                    salaryPeriod: salaryPatch.salaryPeriod,
                  }
                : {}),
            },
          });
          if (
            sanitizedInput.active === false ||
            sanitizedInput.role ||
            Boolean(pinHash)
          ) {
            await revokeSessionsForUser(input.id);
          }
          broadcastUsersChanged({ kind: 'updated', id: updated.id });
          return send(res, 200, lanStaffDto(updated), corsOrigin);
        } catch (e: any) {
          const status = Number(e?.statusCode) === 403 ? 403 : 400;
          return send(
            res,
            status,
            { error: String(e?.message || e || 'update failed') },
            corsOrigin,
          );
        }
      }
      if (req.method === 'POST' && pathname === '/auth/delete-user') {
        try {
          const input = DeleteUserInputSchema.parse(await parseJson(req));
          const id = Number(input.id);
          if (!id) {
            return send(res, 400, { error: 'invalid user id' }, corsOrigin);
          }
          if (!input.hard) {
            await prisma.user.update({
              where: { id },
              data: { active: false },
            });
            await revokeSessionsForUser(id);
            broadcastUsersChanged({ kind: 'updated', id });
            return send(res, 200, true, corsOrigin);
          }
          const user = await prisma.user.findUnique({ where: { id } });
          if (!user) return send(res, 200, true, corsOrigin);
          if (user.role === 'ADMIN' && user.active) {
            const otherActiveAdmins = await prisma.user.count({
              where: {
                role: 'ADMIN' as any,
                active: true,
                id: { not: id },
              } as any,
            });
            if (otherActiveAdmins <= 0) {
              return send(
                res,
                400,
                { error: 'cannot delete the last active admin' },
                corsOrigin,
              );
            }
          }
          const [
            orders,
            tickets,
            notifications,
            shiftsOpened,
            shiftsClosed,
            reqMade,
            reqOwned,
          ] = await Promise.all([
            prisma.order.count({ where: { userId: id } }),
            prisma.ticketLog.count({ where: { userId: id } }),
            prisma.notification.count({ where: { userId: id } }),
            prisma.dayShift.count({ where: { openedById: id } }),
            prisma.dayShift.count({ where: { closedById: id } }),
            prisma.ticketRequest.count({ where: { requesterId: id } }),
            prisma.ticketRequest.count({ where: { ownerId: id } }),
          ]);
          const total =
            orders +
            tickets +
            notifications +
            shiftsOpened +
            shiftsClosed +
            reqMade +
            reqOwned;
          if (total > 0) {
            return send(
              res,
              400,
              { error: 'user has history; disable instead of deleting' },
              corsOrigin,
            );
          }
          await prisma.user.delete({ where: { id } });
          await revokeSessionsForUser(id);
          broadcastUsersChanged({ kind: 'deleted', id });
          return send(res, 200, true, corsOrigin);
        } catch (e: any) {
          return send(
            res,
            400,
            { error: String(e?.message || e || 'delete failed') },
            corsOrigin,
          );
        }
      }

      // Waiter-facing reports (per-user)
      if (req.method === 'GET' && pathname === '/reports/my/overview') {
        const start = new Date(new Date().setHours(0, 0, 0, 0));
        const end = new Date();
        const settings = await coreServices.readSettings();
        const fiscalVatEnabled = isVatEnabledFromSettings(settings);
        const sales = await fetchPaidSales({
          from: start,
          to: end,
          userId: auth!.userId,
        });
        const { revenueNet: revenueTodayNet, revenueVat: revenueTodayVat } =
          sumPaidRevenue(sales, { vatEnabled: fiscalVatEnabled });
        const openList = await coreServices.listOpenTables().catch(() => []);
        const latestMatches = await Promise.all(
          openList.map(async ({ area, label }) => {
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
        const sales = await fetchPaidSales({
          from: start,
          to: end,
          userId: auth!.userId,
        });
        return send(res, 200, topSellingFromSales(sales), corsOrigin);
      }

      if (req.method === 'GET' && pathname === '/reports/my/sales-trends') {
        const range = (parsed.query.range as string) || 'daily';
        const trendRange =
          range === 'weekly' || range === 'monthly' ? range : 'daily';
        const buckets = buildSalesTrendBuckets(trendRange);
        const sales = await fetchPaidSales({
          from: buckets[0].from,
          to: buckets[buckets.length - 1].to,
          userId: auth!.userId,
        });
        return send(
          res,
          200,
          { range: trendRange, points: fillTrendPoints(sales, buckets) },
          corsOrigin,
        );
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
      if (
        req.method === 'POST' &&
        pathname === '/reports/my/print-day-summary'
      ) {
        if (!auth) return send(res, 401, { error: 'unauthorized' }, corsOrigin);
        const result = await printMyDaySummary(auth.userId);
        return send(
          res,
          result.ok ? 200 : 502,
          { ok: result.ok, error: result.error },
          corsOrigin,
        );
      }

      // ----- Reservations (mobile / LAN HOST + ADMIN clients) -----
      // The reservations service throws errors with `statusCode` properties,
      // which the catch-all handler below already maps to the right HTTP code.
      // Auth is already enforced above (these are not in `publicPaths`), and
      // each service call additionally re-checks role from the local DB.
      if (
        pathname.startsWith('/reservations') &&
        storePlanBlocksReservations()
      ) {
        return send(
          res,
          403,
          { error: 'Reservations are not available on the Store plan.' },
          corsOrigin,
        );
      }
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
    try {
      const lan = listLanIpv4Addresses().filter(
        (ip) => !ip.startsWith('169.254.'),
      );
      if (lan.length) {
        console.log(
          `Waiter tablets: same Wi-Fi, then scan or type ${lan
            .map((ip) => `${ip}:${httpPort}`)
            .join(', ')}`,
        );
      }
    } catch {
      // ignore
    }
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
