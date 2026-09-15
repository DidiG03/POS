/**
 * LAN JWT storage for the Capacitor / browser polyfill.
 *
 * Android WebViews sometimes throw on localStorage.setItem (quota, WebView
 * bugs after a pairing wipe). If we only persist to storage, login returns
 * a user, the next GET 401s with no bearer, and maybeForceLogout dumps the
 * waiter back to PIN. Keep a process-lifetime copy so this session still
 * authenticates even when storage is broken.
 */

const memory = new Map<string, string>();
let generation = 0;

export type TokenStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function lanAuthGeneration(): number {
  return generation;
}

export function readLanToken(
  key: string,
  storage?: TokenStorage | null,
): string | null {
  const cached = memory.get(key);
  if (cached) return cached;
  if (!storage) return null;
  try {
    const stored = storage.getItem(key);
    if (stored) memory.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}

export function writeLanToken(
  key: string,
  token: string | null,
  storage?: TokenStorage | null,
): void {
  const prev = memory.get(key) ?? null;
  if (token) memory.set(key, token);
  else memory.delete(key);
  if (prev !== token) generation += 1;
  if (!storage) return;
  try {
    if (token) storage.setItem(key, token);
    else storage.removeItem(key);
  } catch {
    // Memory still has the live token for this process.
  }
}

export function clearLanTokenMemory(): void {
  memory.clear();
  generation += 1;
}

/** PIN / pairing / staff-list calls can 401 without meaning the session died. */
export function isLanAuthBootstrapPath(path?: string | null): boolean {
  const pathname = String(path || '').split('?')[0];
  return (
    pathname === '/auth/login' ||
    pathname === '/pairing/verify' ||
    pathname === '/auth/users' ||
    pathname === '/health'
  );
}

export function isUnauthorizedStatus(status: number): boolean {
  return status === 401;
}

/**
 * A 401 for a token we no longer use (superseded by a fresh PIN login)
 * must not wipe the new session. In-flight GETs from the login screen
 * often finish after setToken(newJwt).
 *
 * A 401 with no bearer still logs out: Admin/waiter can have a persisted
 * PIN session after the LAN JWT is gone, and every host call then returns
 * `{ error: 'unauthorized' }` while the UI stays inside the app.
 */
export function shouldForceLogoutOn401(
  status: number,
  tokenUsed: string | null | undefined,
  currentToken: string | null | undefined,
  gens?: { request: number; current: number },
  path?: string | null,
): boolean {
  if (!isUnauthorizedStatus(status)) return false;
  if (isLanAuthBootstrapPath(path)) return false;
  if (gens && gens.request !== gens.current) return false;
  if (currentToken && tokenUsed && currentToken !== tokenUsed) return false;
  return true;
}

export function lanDedupeKey(
  method: string,
  path: string,
  token: string | null | undefined,
): string {
  const tail = token ? token.slice(-12) : '';
  return `lan:${method}:${path}:${tail}`;
}
