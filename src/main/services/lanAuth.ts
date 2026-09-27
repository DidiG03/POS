/**
 * The LAN bearer token is a signed claim, not the authority on who a user is.
 *
 * Tokens are HMAC-signed and live for 12h, and until now the role inside the
 * token was trusted for all of that time. Deactivating a waiter, demoting an
 * admin or resetting a PIN ended their desktop session (`revokeSessionsForUser`)
 * but left every phone they had signed in on fully working until the token
 * expired.
 *
 * So a verified token is checked against the database on every request:
 *
 *   - the user must still exist and be active;
 *   - the role is the one in the database now, not the one at sign-in;
 *   - a token issued before the user's last revocation is refused.
 *
 * The user lookup is cached for a few seconds because phones poll constantly;
 * revoking a user drops that cache entry, so a revocation is never late.
 */
import { prisma } from '@db/client';

const REVOKED_KEY = 'lan:tokensRevokedBefore';
export const LAN_USER_CACHE_MS = 3_000;

type CachedUser = { at: number; role: string | null };

const userCache = new Map<number, CachedUser>();
let revokedBefore: Record<string, number> | null = null;

async function revokedMap(): Promise<Record<string, number>> {
  if (revokedBefore) return revokedBefore;
  const row = await prisma.syncState
    .findUnique({ where: { key: REVOKED_KEY } })
    .catch(() => null);
  const raw = (row?.valueJson as Record<string, unknown>) || {};
  const map: Record<string, number> = {};
  for (const [id, at] of Object.entries(raw)) {
    const n = Number(at);
    if (Number.isFinite(n) && n > 0) map[id] = n;
  }
  revokedBefore = map;
  return map;
}

/** Current role of an active user, or null when missing / deactivated. */
async function activeRole(userId: number, now: number): Promise<string | null> {
  const hit = userCache.get(userId);
  if (hit && now - hit.at < LAN_USER_CACHE_MS) return hit.role;
  const user = await prisma.user
    .findFirst({ where: { id: userId, active: true } })
    .catch(() => undefined);
  // A lookup failure must not lock the floor out; fall back to the cache.
  if (user === undefined) return hit ? hit.role : null;
  const role = user ? String(user.role || '').toUpperCase() || null : null;
  userCache.set(userId, { at: now, role });
  return role;
}

/**
 * Resolve a signature-verified token to the user it may act as today.
 * `issuedAtMs` is when the token was minted.
 */
export async function resolveLanTokenSubject(
  input: { userId: number; issuedAtMs: number },
  now = Date.now(),
): Promise<{ userId: number; role: string } | null> {
  const userId = Number(input.userId);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const cutoff = (await revokedMap())[String(userId)];
  if (cutoff && !(Number(input.issuedAtMs) >= cutoff)) return null;
  const role = await activeRole(userId, now);
  if (!role) return null;
  return { userId, role };
}

/**
 * Invalidate every LAN token already issued to this user. Called wherever the
 * desktop sessions are revoked: deactivation, deletion, role change, PIN reset.
 */
export async function revokeLanTokensForUser(
  userId: number,
  now = Date.now(),
): Promise<void> {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return;
  userCache.delete(id);
  const map = { ...(await revokedMap()), [String(id)]: now };
  revokedBefore = map;
  await prisma.syncState
    .upsert({
      where: { key: REVOKED_KEY },
      create: { key: REVOKED_KEY, valueJson: map },
      update: { valueJson: map },
    })
    .catch(() => undefined);
  closeLanEventStreamsForUser(id);
}

/** End live SSE streams held by this user so they reconnect and re-auth. */
function closeLanEventStreamsForUser(userId: number): void {
  const clients: Set<any> | undefined = (globalThis as any).__SSE_CLIENTS__;
  if (!clients) return;
  for (const client of [...clients]) {
    if (Number(client?.userId) !== userId) continue;
    clients.delete(client);
    try {
      client.res?.end?.();
    } catch {
      // socket already gone
    }
  }
}

/** Test seam. */
export function __resetLanAuthForTests(): void {
  userCache.clear();
  revokedBefore = null;
}
