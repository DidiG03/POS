/**
 * Main-process session authority for IPC.
 *
 * Until now the renderer was the only place that knew who was logged in: it
 * kept a Zustand store, decided whether to show the admin screens, and passed
 * a `userId` along in payloads. The main process trusted all of it. That means
 * any renderer surface — the KDS window, the reservations window, or an XSS
 * foothold in the POS window — could invoke `backups:restore`, `auth:deleteUser`
 * or `settings:update` simply by naming the channel.
 *
 * This module makes the main process the authority instead. A session is
 * created only inside `auth:loginWithPin`, after bcrypt has verified the PIN,
 * and it is bound to the calling `webContents.id`.
 *
 * Sessions outlive an app restart because the renderer persists its own
 * session for 12h and staff expect to reopen the app without re-entering their
 * PIN. Rather than trusting the renderer's claim on boot, login also hands back
 * an opaque token. The renderer stores that token and presents it on boot via
 * `auth:resumeSession`; we look it up in our own table and rebind it to the new
 * sender. The renderer can't mint one, so restoring a session is not the same
 * as asserting a role.
 *
 * Only the SHA-256 of a token is persisted, so a copy of the local database
 * does not yield usable session tokens.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '@db/client';

/**
 * Which shell a `webContents` is running. Used to grant the kiosk surfaces
 * (the Electron KDS window has no login screen at all) and to make the
 * security log readable.
 */
export type WindowKind = 'pos' | 'admin' | 'kds' | 'reservations' | 'unknown';

export interface IpcSession {
  /** SHA-256 of the token handed to the renderer; never the token itself. */
  tokenHash: string;
  userId: number;
  role: string;
  displayName: string;
  issuedAt: number;
  expiresAt: number;
}

/** Matches the renderer's persisted session TTL so the two expire together. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SESSION_KEY_PREFIX = 'ipc:session:';

const sessionsByTokenHash = new Map<string, IpcSession>();
const tokenHashBySender = new Map<number, string>();
const windowKindBySender = new Map<number, WindowKind>();

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function storeKey(tokenHash: string): string {
  return `${SESSION_KEY_PREFIX}${tokenHash}`;
}

function isExpired(s: IpcSession, now = Date.now()): boolean {
  return s.expiresAt <= now;
}

async function persist(session: IpcSession): Promise<void> {
  const valueJson = {
    userId: session.userId,
    role: session.role,
    displayName: session.displayName,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  };
  await prisma.syncState
    .upsert({
      where: { key: storeKey(session.tokenHash) },
      create: { key: storeKey(session.tokenHash), valueJson },
      update: { valueJson },
    })
    .catch(() => undefined);
}

async function forget(tokenHash: string): Promise<void> {
  sessionsByTokenHash.delete(tokenHash);
  await prisma.syncState
    .delete({ where: { key: storeKey(tokenHash) } })
    .catch(() => undefined);
}

/**
 * Note which shell a `webContents` belongs to. Called from each window factory
 * before the renderer has had a chance to invoke anything.
 */
export function registerWindowKind(senderId: number, kind: WindowKind): void {
  if (!senderId) return;
  windowKindBySender.set(senderId, kind);
}

export function windowKindFor(senderId: number): WindowKind {
  return windowKindBySender.get(senderId) ?? 'unknown';
}

/**
 * Create a session for a user whose PIN has already been verified, and bind it
 * to the calling window. Returns the token the renderer must keep in order to
 * resume after a restart.
 */
export async function createSession(
  senderId: number,
  user: { id: number; role: string; displayName: string },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const now = Date.now();
  const session: IpcSession = {
    tokenHash,
    userId: Number(user.id),
    role: String(user.role || '').toUpperCase(),
    displayName: String(user.displayName || ''),
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessionsByTokenHash.set(tokenHash, session);
  if (senderId) {
    // A window only ever holds one identity; replacing the binding is what
    // makes "log out, log in as someone else" behave.
    const previous = tokenHashBySender.get(senderId);
    if (previous && previous !== tokenHash) void forget(previous);
    tokenHashBySender.set(senderId, tokenHash);
  }
  await persist(session);
  return token;
}

/**
 * Re-attach a previously issued token to a (new) window. Used on renderer boot
 * when a persisted session is still within its TTL.
 */
export async function resumeSession(
  senderId: number,
  token: string,
): Promise<IpcSession | null> {
  const candidate = String(token || '').trim();
  if (!candidate) return null;
  const tokenHash = hashToken(candidate);

  let session = sessionsByTokenHash.get(tokenHash) ?? null;
  if (!session) {
    const row = await prisma.syncState
      .findUnique({ where: { key: storeKey(tokenHash) } })
      .catch(() => null);
    const saved = (row?.valueJson as any) || null;
    if (!saved) return null;
    session = {
      tokenHash,
      userId: Number(saved.userId) || 0,
      role: String(saved.role || '').toUpperCase(),
      displayName: String(saved.displayName || ''),
      issuedAt: Number(saved.issuedAt) || 0,
      expiresAt: Number(saved.expiresAt) || 0,
    };
    if (!session.userId || !session.role) return null;
    sessionsByTokenHash.set(tokenHash, session);
  }

  if (isExpired(session)) {
    await forget(tokenHash);
    return null;
  }

  // The account may have been deleted or deactivated since the token was
  // issued; a resumed session must not outlive the user it names.
  const user = await prisma.user
    .findFirst({ where: { id: session.userId, active: true } })
    .catch(() => null);
  if (!user) {
    await forget(tokenHash);
    return null;
  }
  // Role changes take effect on resume rather than requiring a re-login.
  session.role = String(user.role || '').toUpperCase();
  session.displayName = user.displayName;

  if (senderId) tokenHashBySender.set(senderId, tokenHash);
  return session;
}

/** The live session for a window, or null when nobody is authenticated there. */
export function getSession(senderId: number): IpcSession | null {
  const tokenHash = tokenHashBySender.get(senderId);
  if (!tokenHash) return null;
  const session = sessionsByTokenHash.get(tokenHash);
  if (!session) {
    tokenHashBySender.delete(senderId);
    return null;
  }
  if (isExpired(session)) {
    tokenHashBySender.delete(senderId);
    void forget(tokenHash);
    return null;
  }
  return session;
}

/** Log out: drop the session entirely so its token can never be resumed. */
export async function revokeSession(senderId: number): Promise<void> {
  const tokenHash = tokenHashBySender.get(senderId);
  tokenHashBySender.delete(senderId);
  if (tokenHash) await forget(tokenHash);
}

/**
 * Drop every session belonging to a user. Called when an account is deleted or
 * deactivated so a still-open window loses its privileges immediately.
 */
export async function revokeSessionsForUser(userId: number): Promise<void> {
  const target = Number(userId);
  if (!Number.isFinite(target)) return;
  for (const [tokenHash, session] of [...sessionsByTokenHash.entries()]) {
    if (session.userId !== target) continue;
    for (const [senderId, boundHash] of [...tokenHashBySender.entries()]) {
      if (boundHash === tokenHash) tokenHashBySender.delete(senderId);
    }
    await forget(tokenHash);
  }
  // Sessions that were persisted but never loaded into memory (e.g. issued
  // before this process started) must go too.
  const rows = await prisma.syncState
    .findMany({ where: { key: { startsWith: SESSION_KEY_PREFIX } } })
    .catch(() => [] as any[]);
  for (const row of rows) {
    const saved = (row as any)?.valueJson || null;
    if (Number(saved?.userId) !== target) continue;
    await prisma.syncState
      .delete({ where: { key: (row as any).key } })
      .catch(() => undefined);
  }
}

/**
 * A window was destroyed. The session itself stays valid — the renderer may
 * reopen and resume with its token — but nothing is bound to the stale id.
 */
export function unbindSender(senderId: number): void {
  tokenHashBySender.delete(senderId);
  windowKindBySender.delete(senderId);
}

/** Remove expired rows. Cheap enough to run at boot and on a slow timer. */
export async function pruneExpiredSessions(): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const [tokenHash, session] of [...sessionsByTokenHash.entries()]) {
    if (!isExpired(session, now)) continue;
    await forget(tokenHash);
    removed += 1;
  }
  const rows = await prisma.syncState
    .findMany({ where: { key: { startsWith: SESSION_KEY_PREFIX } } })
    .catch(() => [] as any[]);
  for (const row of rows) {
    const expiresAt = Number((row as any)?.valueJson?.expiresAt) || 0;
    if (expiresAt > now) continue;
    await prisma.syncState
      .delete({ where: { key: (row as any).key } })
      .catch(() => undefined);
    removed += 1;
  }
  return removed;
}

/**
 * Constant-time comparison helper for callers that need to check a token
 * against a known value without leaking length/prefix through timing.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(hashToken(String(a || '')), 'hex');
  const bufB = Buffer.from(hashToken(String(b || '')), 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Test seam: forget everything held in memory. */
export function __resetSessionsForTests(): void {
  sessionsByTokenHash.clear();
  tokenHashBySender.clear();
  windowKindBySender.clear();
}
