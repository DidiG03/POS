/**
 * What a crash report may carry off the till.
 *
 * Reports went to the crash-reporting service with the signed-in staff
 * member's name and whatever an error carried: table payloads with staff
 * and guest names, phone numbers, sometimes a token. A report now keeps
 * the error and where it happened; personal fields are removed and
 * secrets masked (`redactSecrets.ts`). A venue can turn reports off
 * (`privacy.crashReports`).
 */
import { redactLogText } from './redactSecrets';

const PERSONAL_KEYS = new Set(
  [
    'displayName',
    'userName',
    'username',
    'waiterName',
    'customerName',
    'customerPhone',
    'name',
    'email',
    'phone',
    'ip_address',
    'businessInfo',
    'address',
    'note',
  ].map((k) => k.toLowerCase()),
);

const MAX_DEPTH = 8;

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactLogText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[trimmed]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = PERSONAL_KEYS.has(k.toLowerCase())
      ? '[removed]'
      : scrub(v, depth + 1);
  }
  return out;
}

/**
 * The report with personal fields removed and secrets masked. Error
 * messages and stack traces are kept (masked), since they are what makes
 * a report useful; the user is reduced to an id and a role.
 */
export function scrubCrashEvent<T extends Record<string, any>>(event: T): T {
  const next: Record<string, any> = { ...event };
  if (typeof next.message === 'string') {
    next.message = redactLogText(next.message);
  }
  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((v: any) => ({
        ...v,
        value: typeof v?.value === 'string' ? redactLogText(v.value) : v?.value,
      })),
    };
  }
  if (next.user) {
    next.user = {
      ...(next.user.id != null ? { id: String(next.user.id) } : {}),
      ...(next.user.role ? { role: String(next.user.role) } : {}),
    };
  }
  for (const key of ['extra', 'contexts', 'request', 'tags']) {
    if (next[key]) next[key] = scrub(next[key], 0);
  }
  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs.map((b: any) => scrubBreadcrumb(b));
  } else if (Array.isArray(next.breadcrumbs?.values)) {
    next.breadcrumbs = {
      ...next.breadcrumbs,
      values: next.breadcrumbs.values.map((b: any) => scrubBreadcrumb(b)),
    };
  }
  return next as T;
}

export function scrubBreadcrumb<T extends Record<string, any>>(b: T): T {
  if (!b || typeof b !== 'object') return b;
  return {
    ...b,
    ...(typeof b.message === 'string'
      ? { message: redactLogText(b.message) }
      : {}),
    ...(b.data ? { data: scrub(b.data, 0) } : {}),
  } as T;
}

/** Whether the venue allows crash reports (on unless turned off). */
export function crashReportsAllowed(settings: unknown): boolean {
  return (settings as any)?.privacy?.crashReports !== false;
}
