/**
 * Albanian fiskalizimi: invoices issued while CIS is unreachable must be
 * transmitted within 48 hours (from issue, and from reconnect in DPT
 * guidance). The POS takes the sale immediately and the host retries the
 * same frozen docId until NIVF arrives.
 */

export const FISCAL_TRANSMIT_WINDOW_MS = 48 * 60 * 60 * 1000;

export const FISCAL_DEFER_ALERTS = [
  { key: '6h', atMs: 6 * 60 * 60 * 1000 },
  { key: '24h', atMs: 24 * 60 * 60 * 1000 },
  { key: '36h', atMs: 36 * 60 * 60 * 1000 },
  { key: '47h', atMs: 47 * 60 * 60 * 1000 },
  { key: 'overdue', atMs: FISCAL_TRANSMIT_WINDOW_MS },
] as const;

export type FiscalDeferAlertKey = (typeof FISCAL_DEFER_ALERTS)[number]['key'];

export function fiscalIssuedAtMs(iso: string | undefined | null): number {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : Date.now();
}

export function fiscalDeferAgeMs(
  issuedAt: string | undefined | null,
  now = Date.now(),
): number {
  return Math.max(0, now - fiscalIssuedAtMs(issuedAt));
}

export function fiscalDeferDeadlineMs(
  issuedAt: string | undefined | null,
): number {
  return fiscalIssuedAtMs(issuedAt) + FISCAL_TRANSMIT_WINDOW_MS;
}

export function fiscalDeferRemainingMs(
  issuedAt: string | undefined | null,
  now = Date.now(),
): number {
  return fiscalDeferDeadlineMs(issuedAt) - now;
}

export function dueFiscalDeferAlert(
  issuedAt: string | undefined | null,
  lastAlertKey: string | undefined | null,
  now = Date.now(),
): FiscalDeferAlertKey | null {
  const age = fiscalDeferAgeMs(issuedAt, now);
  let due: FiscalDeferAlertKey | null = null;
  for (const step of FISCAL_DEFER_ALERTS) {
    if (age >= step.atMs) due = step.key;
  }
  if (!due || due === lastAlertKey) return null;
  const lastIdx = FISCAL_DEFER_ALERTS.findIndex((s) => s.key === lastAlertKey);
  const dueIdx = FISCAL_DEFER_ALERTS.findIndex((s) => s.key === due);
  if (lastIdx >= 0 && dueIdx <= lastIdx) return null;
  return due;
}
