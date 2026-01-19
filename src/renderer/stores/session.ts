import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';

interface SessionState {
  user: UserDTO | null;
  expiresAtMs: number | null;
  setUser: (u: UserDTO | null) => void;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      user: null,
      expiresAtMs: null,
      setUser: (u: UserDTO | null) =>
        set({
          user: u,
          expiresAtMs: u ? Date.now() + SESSION_TTL_MS : null,
        }),
    }),
    {
      name: 'pos-session',
      version: 2,
      partialize: (state) => ({ user: state.user, expiresAtMs: state.expiresAtMs }),
      migrate: (persisted: any, version) => {
        // v1 stored only { user }. v2 adds expiresAtMs.
        if (version === 1) {
          return { user: persisted?.user ?? null, expiresAtMs: null };
        }
        return persisted as any;
      },
    },
  ),
);


