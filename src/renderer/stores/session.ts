import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';
import { mergeSessionPersist } from './sessionPersist';

interface SessionState {
  user: UserDTO | null;
  expiresAtMs: number | null;
  /**
   * Proof from the main process that this session came from a PIN check.
   * Kept out of `user` so it never reaches a component, a log line, or a
   * payload we send somewhere else.
   */
  sessionToken: string | null;
  /** In-memory only: when this PIN login landed. Used to avoid a shift-guard bounce. */
  authenticatedAt: number;
  hasHydrated: boolean;
  setUser: (u: UserDTO | null) => void;
  setHasHydrated: (v: boolean) => void;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      user: null,
      expiresAtMs: null,
      sessionToken: null,
      authenticatedAt: 0,
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),
      setUser: (u: UserDTO | null) =>
        set((state) => {
          if (!u) {
            return {
              user: null,
              expiresAtMs: null,
              sessionToken: null,
              authenticatedAt: 0,
            };
          }
          const { sessionToken, ...rest } = u;
          return {
            user: rest as UserDTO,
            expiresAtMs: Date.now() + SESSION_TTL_MS,
            sessionToken: sessionToken ?? state.sessionToken,
            authenticatedAt: Date.now(),
          };
        }),
    }),
    {
      name: 'pos-session',
      version: 3,
      partialize: (state) => ({
        user: state.user,
        expiresAtMs: state.expiresAtMs,
        sessionToken: state.sessionToken,
      }),
      merge: (persisted, current) => mergeSessionPersist(persisted, current),
      onRehydrateStorage: () => (_state, _error) => {
        useSessionStore.setState({ hasHydrated: true });
      },
      migrate: (persisted: any, version) => {
        // v1 stored only { user }. v2 added expiresAtMs. v3 adds sessionToken;
        // sessions from older versions have no token and must re-authenticate.
        if (version === 1) {
          return {
            user: persisted?.user ?? null,
            expiresAtMs: null,
            sessionToken: null,
          };
        }
        if (version === 2) {
          return { ...(persisted ?? {}), sessionToken: null };
        }
        return persisted as any;
      },
    },
  ),
);

if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    if (!useSessionStore.getState().hasHydrated) {
      useSessionStore.setState({ hasHydrated: true });
    }
  }, 400);
}
