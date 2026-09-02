import type { IpcSession } from './ipcSession';

/**
 * Binding a payload's `userId` to the window that sent it.
 *
 * `ipcHandle` authenticates the *window* — it knows a session exists and what
 * role it has. Handlers that act "as a user" then read the id out of the
 * payload, which the renderer supplies. That is enough for a waiter to clock in
 * as a colleague, read another waiter's sales and void history, approve table
 * requests addressed to someone else, or log an order under an admin's id to
 * slip past the table-ownership check. The LAN HTTP API already compares the
 * payload id with the bearer token; these helpers give the IPC path the same
 * rule.
 *
 * A window with no session at all (the kitchen display, which never logs in) is
 * left alone: those channels are granted by window identity and carry no user
 * to impersonate.
 */

export interface ActorContext {
  session: IpcSession | null;
}

/** True when the sender may act as `claimedUserId`. */
export function actorIdentityAllows(
  ctx: ActorContext | null | undefined,
  claimedUserId: unknown,
): boolean {
  const session = ctx?.session ?? null;
  if (!session) return true;
  // Managers legitimately act on other users (approving, correcting a shift).
  if (session.role === 'ADMIN') return true;
  const claimed = Number(claimedUserId);
  if (!Number.isFinite(claimed) || claimed <= 0) return true;
  return claimed === session.userId;
}

/**
 * The id the handler should actually use.
 *
 * Falls back to the session's own id so a payload that omits the field (or
 * carries a stale one) still resolves to the person at the terminal.
 */
export function resolveActorUserId(
  ctx: ActorContext | null | undefined,
  claimedUserId: unknown,
): number {
  const session = ctx?.session ?? null;
  const claimed = Number(claimedUserId);
  const valid = Number.isFinite(claimed) && claimed > 0;
  if (!session) return valid ? claimed : 0;
  if (session.role === 'ADMIN') return valid ? claimed : session.userId;
  return session.userId;
}
