import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';
import { mergeSessionPersist } from './sessionPersist';

interface AdminSessionState {
  user: UserDTO | null;
  expiresAtMs: number | null;
  /** See the note in `session.ts` — kept separate from `user` on purpose. */
  sessionToken: string | null;
  setUser: (u: UserDTO | null) => void;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Separate persisted session for the Admin window so it does not get overwritten
// by the main POS (waiter/cashier) session.
export const useAdminSessionStore = create<AdminSessionState>()(
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
            sessionToken: sessionToken ?? state.sessionToken,
          };
        }),
    }),
    {
      name: 'pos-admin-session',
      version: 3,
      partialize: (state) => ({
        user: state.user,
        expiresAtMs: state.expiresAtMs,
        sessionToken: state.sessionToken,
      }),
      merge: (persisted, current) => mergeSessionPersist(persisted, current),
      migrate: (persisted: any, version) => {
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
