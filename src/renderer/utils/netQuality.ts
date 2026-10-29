/**
 * Live picture of how painful the LAN is right now.
 *
 * Used to (a) stop hammering a congested restaurant Wi-Fi with polls,
 * (b) skip the HTTP→HTTPS fallback once we know which scheme works, and
 * (c) keep Send/Pay enabled through a slow stretch instead of greying
 * them out because a heartbeat timed out.
 */

const RTT_SAMPLES = 8;
const rtts: number[] = [];
let failStreak = 0;
let lastSuccessAt = 0;
let lastFailureAt = 0;
let sseOpen = false;
let lastSseAt = 0;
let preferredScheme: 'http' | 'https' | null = null;

const SCHEME_KEY = 'pos_lan_scheme';

function readStoredScheme(): 'http' | 'https' | null {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    if (v === 'http' || v === 'https') return v;
  } catch {
    // ignore
  }
  return null;
}

preferredScheme =
  typeof localStorage !== 'undefined' ? readStoredScheme() : null;

export function recordSuccess(rttMs: number): void {
  failStreak = 0;
  lastSuccessAt = Date.now();
  if (!Number.isFinite(rttMs) || rttMs < 0) return;
  rtts.push(rttMs);
  if (rtts.length > RTT_SAMPLES) rtts.shift();
}

export function recordFailure(): void {
  failStreak += 1;
  lastFailureAt = Date.now();
}

export function resetFailStreak(): void {
  failStreak = 0;
}

export function markSseOpen(open: boolean): void {
  sseOpen = open;
  if (open) lastSseAt = Date.now();
}

export function noteSseEvent(): void {
  sseOpen = true;
  lastSseAt = Date.now();
}

export function isSseHealthy(now = Date.now()): boolean {
  if (!sseOpen) return false;
  return now - lastSseAt < 25_000;
}

export function medianRtt(): number | null {
  if (!rtts.length) return null;
  const sorted = [...rtts].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/**
 * True when the link is congested or dropping — not merely "a bit slow".
 * A single timeout must not flip this; that's what used to freeze Pay.
 */
export function isLinkDegraded(now = Date.now()): boolean {
  if (failStreak >= 3) return true;
  const rtt = medianRtt();
  if (rtt != null && rtt >= 1500 && failStreak >= 1) return true;
  if (
    lastFailureAt > lastSuccessAt &&
    now - lastFailureAt < 8_000 &&
    failStreak >= 2
  )
    return true;
  return false;
}

/**
 * True only after we have actually failed to reach the host, not when
 * Wi-Fi is merely slow. Native shells often report navigator.onLine
 * false on LAN-only networks, so we never trust that flag alone.
 */
export function isHostUnreachable(now = Date.now()): boolean {
  if (failStreak < 3) return false;
  if (lastSuccessAt && now - lastSuccessAt < 12_000) return false;
  return now - lastFailureAt < 30_000;
}

export function pollIntervalMs(baseMs: number, hidden = false): number {
  if (hidden) return Math.max(baseMs * 3, 12_000);
  if (isLinkDegraded()) return Math.max(baseMs * 3, 12_000);
  if (isSseHealthy()) return Math.max(baseMs * 2.5, 8_000);
  return baseMs;
}

export function readRetryAttempts(): number {
  return isLinkDegraded() ? 1 : 2;
}

export function getPreferredScheme(): 'http' | 'https' | null {
  return preferredScheme;
}

export function setPreferredScheme(scheme: 'http' | 'https'): void {
  preferredScheme = scheme;
  try {
    localStorage.setItem(SCHEME_KEY, scheme);
  } catch {
    // ignore
  }
}

export function lanBases(httpBase: string, httpsBase: string): string[] {
  if (preferredScheme === 'https') return [httpsBase, httpBase];
  if (preferredScheme === 'http') return [httpBase];
  return [httpBase, httpsBase];
}

/** Till heartbeat while it answers (phones / browsers). */
export const HEARTBEAT_OK_MS = 5_000;
/** Longest gap between heartbeats while the till is silent. */
export const HEARTBEAT_MAX_MS = 30_000;
/** Misses in a row before the till is shown as unreachable. */
export const HEARTBEAT_MISSES_FOR_DOWN = 2;

/**
 * When to ping the till next: every 5 s while it answers, then backing off
 * (5, 10, 20, 30 s…) while it does not, so a dead till is not hammered but
 * its return is still noticed within half a minute.
 */
export function heartbeatDelayMs(misses: number): number {
  const n = Math.max(0, Math.floor(Number(misses) || 0));
  if (n === 0) return HEARTBEAT_OK_MS;
  return Math.min(HEARTBEAT_MAX_MS, HEARTBEAT_OK_MS * 2 ** (n - 1));
}
