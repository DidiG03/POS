/**
 * The staff session token of the LAN API: checked here, before the user's
 * role and active state are looked up (`lanAuth.ts`).
 *
 * Session, manager-approval and device tokens share one signing secret and
 * one format. The session check used to accept any of them that named a
 * user: the 5-minute approval token an admin's PIN puts on a waiter's
 * phone (`/auth/verify-manager-pin`) then worked as that admin's session
 * on every admin route (audit 2026-11, C1). A session token carries no
 * `purpose`; any token that does is something else and is refused. A
 * session token must also expire.
 */
import crypto from 'node:crypto';

export type SessionTokenClaims = { userId: number; issuedAtMs: number };

function base64urlDecode(part: string): string {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

function sign(secret: string, body: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** The claims of a valid, unexpired session token, or null. */
export function decodeLanSessionToken(
  secret: string,
  token: string,
  nowMs = Date.now(),
): SessionTokenClaims | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = sign(secret, `${h}.${p}`);
  if (s.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s))) {
    return null;
  }
  let payload: any;
  try {
    payload = JSON.parse(base64urlDecode(p));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  // An approval (`manager_approval`) or device token: never a session.
  if (payload.purpose !== undefined) return null;
  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(nowMs / 1000)) return null;
  const issuedAtMs = Number.isFinite(Number(payload.iatMs))
    ? Number(payload.iatMs)
    : Number(payload.iat) * 1000;
  return { userId, issuedAtMs };
}

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function encode(secret: string, claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = `${header}.${base64url(JSON.stringify(claims))}`;
  return `${body}.${sign(secret, body)}`;
}

/** A staff session, 12 hours by default. */
export function issueLanSessionToken(
  secret: string,
  ctx: { userId: number; role?: string },
  ttlSeconds = 12 * 60 * 60,
  nowMs = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  return encode(secret, {
    sub: ctx.userId,
    role: ctx.role,
    iat: now,
    // Millisecond issue time so a revocation in the same second as a
    // fresh sign-in does not reject the new token.
    iatMs: nowMs,
    exp: now + ttlSeconds,
  });
}

/**
 * A manager approval: one action, 5 minutes. Never a session: it carries
 * `purpose`, which `decodeLanSessionToken` refuses.
 */
export function issueManagerApprovalToken(
  secret: string,
  ctx: { userId: number; role?: string },
  ttlSeconds = 5 * 60,
  nowMs = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  return encode(secret, {
    sub: ctx.userId,
    role: ctx.role,
    purpose: 'manager_approval',
    // Two approvals in the same second must still be two tokens: each
    // covers one action (see `approvalUse.ts`).
    nonce: base64url(crypto.randomBytes(9)),
    iat: now,
    exp: now + ttlSeconds,
  });
}
