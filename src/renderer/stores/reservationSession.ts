import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';

interface ReservationSessionState {
  user: UserDTO | null;
  expiresAtMs: number | null;
  /** See the note in `session.ts` — kept separate from `user` on purpose. */
  sessionToken: string | null;
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
      name: 'pos-host-session',
      version: 2,
      partialize: (state) => ({
        user: state.user,
        expiresAtMs: state.expiresAtMs,
        sessionToken: state.sessionToken,
      }),
      migrate: (persisted: any, version) => {
        // v1 had no token; those sessions must re-authenticate once.
        if (version === 1) return { ...(persisted ?? {}), sessionToken: null };
        return persisted as any;
      },
    },
  ),
);
