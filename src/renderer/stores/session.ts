import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDTO } from '@shared/ipc';

interface SessionState {
  user: UserDTO | null;
  setUser: (u: UserDTO | null) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (u: UserDTO | null) => set({ user: u }),
    }),
    {
      name: 'pos-session',
      version: 1,
      partialize: (state) => ({ user: state.user }),
    },
  ),
);


