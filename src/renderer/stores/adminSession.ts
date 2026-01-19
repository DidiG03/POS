import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';

interface AdminSessionState {
  user: UserDTO | null;
  expiresAtMs: number | null;
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
      setUser: (u: UserDTO | null) =>
        set({
          user: u,
          expiresAtMs: u ? Date.now() + SESSION_TTL_MS : null,
        }),
    }),
    {
      name: 'pos-admin-session',
      version: 2,
      partialize: (state) => ({ user: state.user, expiresAtMs: state.expiresAtMs }),
      migrate: (persisted: any, version) => {
        if (version === 1) {
          return { user: persisted?.user ?? null, expiresAtMs: null };
        }
        return persisted as any;
      },
    },
  ),
);

