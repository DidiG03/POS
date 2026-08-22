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

type SessionStore = {
  getState: () => {
    user: unknown;
    sessionToken: string | null;
    setUser: (u: null) => void;
  };
};

function storeForCurrentShell(): SessionStore {
  const hash = typeof window !== 'undefined' ? window.location.hash || '' : '';
  if (hash.startsWith('#/admin')) return useAdminSessionStore as SessionStore;
  if (hash.startsWith('#/reservations'))
    return useReservationSessionStore as SessionStore;
  return useSessionStore as SessionStore;
}

export async function resumeMainProcessSession(): Promise<void> {
  // Browser and Capacitor clients talk to the host over HTTP, which carries
  // its own bearer token; there is no main-process binding to restore, and
  // their `window.api` shim has no real session to report on.
  if (typeof window !== 'undefined' && (window as any).__BROWSER_CLIENT__)
    return;

  const api = (window as any)?.api;
  if (typeof api?.auth?.resumeSession !== 'function') return;

  const store = storeForCurrentShell();
  const { user, sessionToken, setUser } = store.getState();
  if (!sessionToken) {
    // A persisted user with no token predates this mechanism (or was revoked).
    // It cannot be proven, so it cannot be trusted.
    if (user) setUser(null);
    return;
  }

  let resumed: unknown;
  try {
    resumed = await api.auth.resumeSession(sessionToken);
  } catch {
    // Transport failure is not proof of an invalid session. Leave the stored
    // session alone; the guarded channels will reject until a retry succeeds,
    // which is the safe direction to fail in.
    return;
  }
  if (!resumed) setUser(null);
}
