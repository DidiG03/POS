/**
 * Re-establish the main process's view of who is logged in, at boot.
 *
 * The renderer keeps its session for 12h so staff can reopen the app without
 * retyping a PIN. The main process no longer takes that on faith: privileged
 * IPC channels require a session it created itself during `loginWithPin`, and
 * that binding dies with the process. This module hands back the token issued
 * at login so the main process can recognise the session as one of its own.
 *
 * Which store to resume is decided the same way `routes.tsx` decides which
 * store to *read*, because all three shells share one origin and therefore one
 * localStorage.
 */

import { useSessionStore } from '../stores/session';
import { useAdminSessionStore } from '../stores/adminSession';
import { useReservationSessionStore } from '../stores/reservationSession';

export type SessionStore = {
  getState: () => {
    user: unknown;
    sessionToken: string | null;
    setUser: (u: null) => void;
    hasHydrated?: boolean;
  };
  persist?: {
    hasHydrated?: () => boolean;
    onFinishHydration?: (fn: (state?: unknown) => void) => () => void;
  };
};

function storeForCurrentShell(): SessionStore {
  const hash = typeof window !== 'undefined' ? window.location.hash || '' : '';
  if (hash.startsWith('#/admin')) return useAdminSessionStore as SessionStore;
  if (hash.startsWith('#/reservations'))
    return useReservationSessionStore as SessionStore;
  return useSessionStore as SessionStore;
}

/**
 * localStorage rehydrate is a microtask. 4s used to block "Connecting to POS
 * backend…" whenever `onFinishHydration` was missed (already-hydrated race).
 */
export const PERSIST_HYDRATION_WAIT_MS = 400;

export function persistHasHydrated(store: SessionStore): boolean {
  if (store.persist?.hasHydrated?.()) return true;
  return store.getState()?.hasHydrated === true;
}

export function waitForPersistHydration(
  store: SessionStore,
  ms = PERSIST_HYDRATION_WAIT_MS,
): Promise<void> {
  if (persistHasHydrated(store)) return Promise.resolve();
  if (!store.persist?.onFinishHydration) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const unsub = store.persist?.onFinishHydration?.(finish);
    // Hydration can finish between the first check and the subscribe.
    if (persistHasHydrated(store)) {
      if (typeof unsub === 'function') unsub();
      finish();
      return;
    }
    setTimeout(() => {
      if (typeof unsub === 'function') unsub();
      finish();
    }, ms);
  });
}

let inFlight: Promise<boolean> | null = null;
let boundToken: string | null = null;

/** Test seam: drop in-flight / already-bound state between cases. */
export function resetResumeBindStateForTests(): void {
  inFlight = null;
  boundToken = null;
}

function isResumeRateLimited(err: unknown): boolean {
  const any = err as { code?: unknown; message?: unknown };
  const code = String(any?.code || any?.message || err || '');
  return code.includes('rate_limited');
}

/**
 * Bind the persisted PIN session to this window's IPC sender.
 *
 * Returns true when the renderer may call session-gated channels (or when
 * there is no session and the login screen should show). False means the
 * bind did not complete and the caller should wait rather than hit those
 * channels — that is what produced `ipc_denied` / unauthenticated floods.
 */
export async function resumeMainProcessSession(
  store: SessionStore = storeForCurrentShell(),
): Promise<boolean> {
  // Browser and Capacitor clients talk to the host over HTTP, which carries
  // its own bearer token; there is no main-process binding to restore, and
  // their `window.api` shim has no real session to report on.
  if (typeof window !== 'undefined' && (window as any).__BROWSER_CLIENT__)
    return true;

  const api = (window as any)?.api;
  if (typeof api?.auth?.resumeSession !== 'function') return true;

  if (inFlight) return inFlight;
  inFlight = bindMainProcessSession(store, api).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function bindMainProcessSession(
  store: SessionStore,
  api: { auth: { resumeSession: (token: string) => Promise<unknown> } },
): Promise<boolean> {
  await waitForPersistHydration(store);
  const { user, sessionToken, setUser } = store.getState();
  if (!sessionToken) {
    boundToken = null;
    // A persisted user with no token predates this mechanism (or was revoked).
    // It cannot be proven, so it cannot be trusted.
    if (user) setUser(null);
    return true;
  }

  if (boundToken === sessionToken) return true;

  try {
    const resumed = await api.auth.resumeSession(sessionToken);
    if (!resumed) {
      boundToken = null;
      setUser(null);
      return true;
    }
    boundToken = sessionToken;
    return true;
  } catch (err) {
    if (isResumeRateLimited(err) && user && sessionToken) {
      // Main already counted this window out. Retrying is what flooded
      // `rate_limit_exceeded` during HMR; the local session is still the one
      // issued at PIN login, so let the gate proceed.
      boundToken = sessionToken;
      return true;
    }
    // Transport failure is not proof of an invalid session. Leave the stored
    // session alone and tell the gate to wait — calling notifications/floor
    // now would only log ipc_denied.
    return false;
  }
}
