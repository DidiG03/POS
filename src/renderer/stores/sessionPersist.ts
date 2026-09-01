/**
 * Zustand persist helpers for PIN sessions.
 *
 * Tablets often finish login before localStorage rehydration. Persist then
 * writes the *old* empty session over the new one, so the waiter sees Tables
 * for a moment and lands back on the PIN screen. Prefer a still-fresh
 * in-memory login when merging.
 */

export type SessionPersistSlice = {
  user: unknown;
  expiresAtMs: number | null;
  sessionToken: string | null;
  authenticatedAt?: number;
};

/** Skip the post-login "is the shift still open?" bounce for this long. */
export const SHIFT_GUARD_GRACE_MS = 30_000;

export function isSessionFresh(
  expiresAtMs: number | null | undefined,
  now = Date.now(),
): boolean {
  return typeof expiresAtMs === 'number' && expiresAtMs > now;
}

export function shouldDeferShiftGuard(input: {
  hasHydrated: boolean;
  isBrowser: boolean;
  isKdsContext: boolean;
  userId?: number | null;
  authenticatedAt: number;
  now?: number;
}): boolean {
  if (!input.hasHydrated) return true;
  if (!input.isBrowser || input.isKdsContext || !input.userId) return true;
  const now = input.now ?? Date.now();
  return (
    input.authenticatedAt > 0 &&
    now - input.authenticatedAt < SHIFT_GUARD_GRACE_MS
  );
}

export function mergeSessionPersist<T extends SessionPersistSlice>(
  persisted: unknown,
  current: T,
): T {
  const p = (
    persisted && typeof persisted === 'object' ? persisted : {}
  ) as Partial<T> & SessionPersistSlice;
  const liveTs = Number(current.expiresAtMs || 0);
  const storedTs = Number(p.expiresAtMs || 0);
  const storedHasUser = Boolean(p.user);
  const storedFresh = isSessionFresh(p.expiresAtMs);

  // Never clobber a live PIN login with empty or stale storage.
  if (current.user) {
    if (!storedHasUser) return current;
    if (!storedFresh) return current;
    if (liveTs >= storedTs) return current;
  }

  if (storedHasUser && !storedFresh) {
    return {
      ...current,
      user: null,
      expiresAtMs: null,
      sessionToken: null,
    };
  }

  const adopted = { ...current, ...p };
  if ('authenticatedAt' in adopted) {
    adopted.authenticatedAt = 0;
  }
  return adopted;
}
