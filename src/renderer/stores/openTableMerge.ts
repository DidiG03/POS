/**
 * Reconcile the till's optimistic view of which tables are occupied with the
 * host's answer.
 *
 * An optimistic close (tapping Pay, voiding a ticket) has to win briefly, or
 * the table flashes back to occupied before the write lands. It must never
 * win forever: `OrderPage` refuses to load a ticket for a table it believes
 * is free, so a stuck "free" flag hides a live bill and lets the next Send
 * overwrite it. That is why the offline case is bounded too, and why the
 * timestamps are dropped on boot — after a restart the host is the only
 * source worth trusting.
 */

/** How long an optimistic open/close outranks the host's answer. */
export const OPTIMISTIC_OPEN_TTL_MS = 60_000;

/**
 * Offline reads come from the stale read cache, so an optimistic flag has to
 * survive longer than one poll — but still expire, so a table cannot stay
 * wrong for a whole shift on a till with no network.
 */
export const OFFLINE_OPTIMISTIC_OPEN_TTL_MS = 5 * 60_000;

export function optimisticOpenTtlMs(offline: boolean): number {
  return offline ? OFFLINE_OPTIMISTIC_OPEN_TTL_MS : OPTIMISTIC_OPEN_TTL_MS;
}

export function mergeOpenTables(input: {
  /** The host's list of occupied tables. */
  incoming: Array<{ area: string; label: string }>;
  openMap: Record<string, boolean>;
  lastSetAt: Record<string, number>;
  keyOf: (area: string, label: string) => string;
  now?: number;
  offline?: boolean;
}): Record<string, boolean> {
  const now = input.now ?? Date.now();
  const ttlMs = optimisticOpenTtlMs(Boolean(input.offline));

  const merged: Record<string, boolean> = {};
  for (const entry of input.incoming || []) {
    if (!entry?.area || !entry?.label) continue;
    merged[input.keyOf(entry.area, entry.label)] = true;
  }

  for (const key of Object.keys(input.openMap || {})) {
    const last = Number(input.lastSetAt?.[key] || 0);
    if (last <= 0) continue;
    if (now - last > ttlMs) continue;
    merged[key] = input.openMap[key];
  }

  for (const key of Object.keys(merged)) {
    if (!merged[key]) delete merged[key];
  }
  return merged;
}

/** Optimistic writes are per-session; a restart must not inherit them. */
export function dropOptimisticOpenState<
  T extends { lastSetAt?: Record<string, number> },
>(state: T): T {
  return { ...state, lastSetAt: {} };
}
