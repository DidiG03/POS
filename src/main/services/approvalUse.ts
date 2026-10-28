/**
 * One manager approval, one action.
 *
 * Approval tokens (the till's random ones and the LAN HMAC ones) used to be
 * valid for anything during their five minutes, so one manager PIN typed
 * for one void covered three. Each use now claims the token for a scope —
 * the action, the table and the line — and a token already claimed for
 * another scope is refused.
 *
 * The same action retried (the phone's offline queue replaying a void whose
 * answer was lost) carries the same idempotency key and is still accepted;
 * the action itself is idempotent, so the retry changes nothing.
 *
 * Kept in memory: a restart drops the claims, and the tokens with them (the
 * till's tokens live in memory too, and the LAN ones expire in five minutes).
 */

type Claim = { scope: string; keys: Set<string>; expiresAt: number };

function store(): Map<string, Claim> {
  const g = globalThis as any;
  if (!g.__approvalUses) g.__approvalUses = new Map();
  return g.__approvalUses as Map<string, Claim>;
}

function prune(now: number): void {
  for (const [id, c] of store()) if (c.expiresAt <= now) store().delete(id);
}

/** `VOID_ITEM|Main|T1|<line>`: what one approval may be used for. */
export function approvalScope(
  action: 'VOID_ITEM' | 'VOID_TICKET' | 'PAYMENT' | 'CORRECT_SALE',
  ...parts: Array<string | number | null | undefined>
): string {
  return [action, ...parts.map((p) => String(p ?? '').trim())].join('|');
}

/** Line identity for a void scope: its Send key, else its name. */
export function voidLineIdentity(item: unknown): string {
  const it = (item || {}) as Record<string, unknown>;
  return String(it.lineId || it.sendKey || it.sku || it.name || '').trim();
}

/**
 * Claim `tokenId` for `scope`. True when this is its first use, or a retry
 * of that same use (same scope and idempotency key).
 */
export function claimApprovalUse(input: {
  tokenId: string;
  scope: string;
  idempotencyKey?: string | null;
  expiresAt: number;
  now?: number;
  /**
   * Any request with the same scope may reuse the claim (a payment retried
   * after a fiscal hiccup gets a fresh key; it is still the same bill).
   */
  anyKeyInScope?: boolean;
}): boolean {
  const now = input.now ?? Date.now();
  prune(now);
  const id = String(input.tokenId || '');
  if (!id) return false;
  const key = String(input.idempotencyKey || '').trim();
  const existing = store().get(id);
  if (!existing) {
    store().set(id, {
      scope: input.scope,
      keys: new Set(key ? [key] : []),
      expiresAt: Math.max(input.expiresAt, now + 1),
    });
    return true;
  }
  if (existing.scope !== input.scope) return false;
  if (input.anyKeyInScope) return true;
  return key !== '' && existing.keys.has(key);
}

/**
 * Give a claim back when the action did not happen (nothing matched, the
 * line was already paid), so the manager does not have to type the PIN
 * again for the same request.
 */
export function releaseApprovalUse(tokenId: string, scope: string): void {
  const c = store().get(String(tokenId || ''));
  if (c && c.scope === scope && c.keys.size <= 1) {
    store().delete(String(tokenId));
  }
}

/** Test seam. */
export function __clearApprovalUses(): void {
  store().clear();
}
