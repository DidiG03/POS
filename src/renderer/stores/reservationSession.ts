import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';

interface ReservationSessionState {
  user: UserDTO | null;
  expiresAtMs: number | null;
  setUser: (u: UserDTO | null) => void;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Layout namespace used by the reservation panel when persisting per-user
// floor layouts. Kept here so all callers reference the same constant.
export const HOST_LAYOUT_SCOPE = 'host';

// Persisted independently from the POS and Admin sessions so signing in to
// the reservation window cannot overwrite the active waiter or admin.
export const useReservationSessionStore = create<ReservationSessionState>()(
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
      name: 'pos-host-session',
      version: 1,
      partialize: (state) => ({
        user: state.user,
        expiresAtMs: state.expiresAtMs,
      }),
    },
  ),
);
