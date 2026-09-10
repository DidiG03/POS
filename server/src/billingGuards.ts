/**
 * Pure billing rules used by the Stripe license API.
 * Kept free of Stripe/Express so they can be unit-tested.
 */

export type LicenseSubStatus = 'ACTIVE' | 'PAST_DUE' | 'PAUSED';

export function mapSubStatus(raw: string): LicenseSubStatus {
  const s = String(raw || '').toLowerCase();
  if (s === 'active' || s === 'trialing') return 'ACTIVE';
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete') return 'PAST_DUE';
  return 'PAUSED';
}

/** Only an active (or trialing) sub may mint or refresh a POS license key. */
export function canIssueLicense(status: LicenseSubStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * past_due / unpaid / incomplete already have a subscription. Opening Checkout
 * would create a second one and double-charge. Send them to the portal.
 */
export function shouldUpdatePaymentInsteadOfCheckout(
  status: LicenseSubStatus,
): boolean {
  return status === 'PAST_DUE';
}

function headerFirst(
  value: string | string[] | undefined,
): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '')
    .split(',')[0]
    .trim();
}

/**
 * Client IP for rate limits. Prefer platform-set headers (Vercel overwrites
 * x-real-ip). Never take the first X-Forwarded-For hop — that value is
 * caller-controlled.
 */
export function clientIpFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string | null,
): string {
  const real =
    headerFirst(headers['x-real-ip']) ||
    headerFirst(headers['x-vercel-forwarded-for']);
  if (real) return real;
  const xff = String(headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length > 0) return xff[xff.length - 1]!;
  const sock = String(remoteAddress || '').trim();
  return sock || 'unknown';
}

type HitBucket = { count: number; resetAt: number };

const hits = new Map<string, HitBucket>();

export function allowRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const cur = hits.get(key);
  if (!cur || cur.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (cur.count >= max) return false;
  cur.count += 1;
  return true;
}

/** Test-only. */
export function resetRateLimitsForTests(): void {
  hits.clear();
}
