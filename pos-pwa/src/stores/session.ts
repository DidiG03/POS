import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: number;
  displayName: string;
  role?: string;
}

interface SessionState {
  user: User | null;
  setUser: (u: User | null) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (u: User | null) => set({ user: u }),
    }),
    {
      name: 'pos-session',
      version: 1,
      partialize: (state) => ({ user: state.user }),
    },
  ),
);


