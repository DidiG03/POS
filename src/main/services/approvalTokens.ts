import crypto from 'node:crypto';
import { claimApprovalUse } from './approvalUse';

/**
 * Short-lived proof that a manager typed their PIN on this machine.
 *
 * Manager approval is the only control standing between a waiter and voiding
 * their own items, so the privileged operation cannot trust an
 * `approvedByAdminId` that the caller made up: any active admin's id is easy to
 * guess, and the ids are listed on the login screen. `auth:verifyManagerPin`
 * hands back one of these tokens and the void handlers require it, which is the
 * same rule the LAN HTTP API already enforces with an HMAC token.
 *
 * A token covers the one action it is first used for, including a retry of
 * that action from the offline queue (see `approvalUse.ts`); the five-minute
 * expiry bounds how long it waits to be used.
 */

export const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface ApprovalGrant {
  userId: number;
  role: string;
  expiresAt: number;
}

/** Attached to `globalThis` so a dev reload doesn't strand live approvals. */
function store(): Map<string, ApprovalGrant> {
  const g = globalThis as any;
  if (!g.__approvalTokensLocal) g.__approvalTokensLocal = new Map();
  return g.__approvalTokensLocal as Map<string, ApprovalGrant>;
}

function prune(now: number): void {
  const map = store();
  for (const [token, grant] of map) {
    if (grant.expiresAt <= now) map.delete(token);
  }
}

export function issueApprovalToken(
  userId: number,
  role = 'ADMIN',
  now = Date.now(),
): string {
  prune(now);
  const token = crypto.randomBytes(24).toString('base64url');
  store().set(token, {
    userId: Number(userId),
    role: String(role || '').toUpperCase(),
    expiresAt: now + APPROVAL_TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Resolve a token to the admin who approved, or `null` when it is missing,
 * unknown or expired.
 */
export function verifyApprovalToken(
  token: unknown,
  now = Date.now(),
): ApprovalGrant | null {
  const key = String(token ?? '').trim();
  if (!key) return null;
  prune(now);
  const grant = store().get(key);
  if (!grant) return null;
  if (grant.expiresAt <= now) {
    store().delete(key);
    return null;
  }
  return grant;
}

/**
 * True when `token` is a live approval granted by admin `userId`.
 *
 * Both halves matter: the token proves a PIN was entered, and the id check
 * stops a waiter from replaying a real approval while naming a different admin
 * in the audit trail.
 */
export function isApprovalValidFor(
  token: unknown,
  userId: unknown,
  now = Date.now(),
): boolean {
  const grant = verifyApprovalToken(token, now);
  if (!grant) return false;
  if (grant.role !== 'ADMIN') return false;
  const id = Number(userId);
  return Number.isFinite(id) && id > 0 && grant.userId === id;
}

/**
 * `isApprovalValidFor`, and claim the token for `scope` so it cannot be
 * used for a different action (see `approvalUse.ts`).
 */
export function claimApprovalFor(
  token: unknown,
  userId: unknown,
  scope: string,
  idempotencyKey?: string | null,
  opts: { anyKeyInScope?: boolean } = {},
  now = Date.now(),
): boolean {
  if (!isApprovalValidFor(token, userId, now)) return false;
  const grant = verifyApprovalToken(token, now)!;
  return claimApprovalUse({
    tokenId: String(token).trim(),
    scope,
    idempotencyKey,
    expiresAt: grant.expiresAt,
    now,
    anyKeyInScope: opts.anyKeyInScope,
  });
}

/** Test seam only. */
export function __clearApprovalTokens(): void {
  store().clear();
}
