import { create } from 'zustand';
import type { UserDTO } from '@shared/ipc';

interface SessionState {
  user: UserDTO | null;
  setUser: (u: UserDTO | null) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  user: null,
  setUser: (u: UserDTO | null) => set({ user: u }),
}));


