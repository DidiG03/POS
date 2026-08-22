import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';

interface SessionState {
  user: UserDTO | null;
  expiresAtMs: number | null;
  /**
   * Proof from the main process that this session came from a PIN check.
   * Kept out of `user` so it never reaches a component, a log line, or a
   * payload we send somewhere else.
   */
  sessionToken: string | null;
  setUser: (u: UserDTO | null) => void;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      user: null,
      expiresAtMs: null,
      sessionToken: null,
      setUser: (u: UserDTO | null) =>
        set((state) => {
          if (!u) return { user: null, expiresAtMs: null, sessionToken: null };
          const { sessionToken, ...rest } = u;
          return {
            user: rest as UserDTO,
            expiresAtMs: Date.now() + SESSION_TTL_MS,
            // Callers that refresh the user object without re-authenticating
            // (a role refresh, say) must not wipe the token.
            sessionToken: sessionToken ?? state.sessionToken,
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
