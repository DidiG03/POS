import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PendingAction = 'send' | 'pay' | null;
export interface SelectedTable {
  id: number;
  label: string;
  area: string;
}

interface OrderContextState {
  selectedTable: SelectedTable | null;
  pendingAction: PendingAction;
  setSelectedTable: (t: SelectedTable | null) => void;
  setPendingAction: (a: PendingAction) => void;
  clear: () => void;
}

export const useOrderContext = create<OrderContextState>()(
  persist(
    (set) => ({
      selectedTable: null,
      pendingAction: null,
      setSelectedTable: (t) => set({ selectedTable: t }),
      setPendingAction: (a) => set({ pendingAction: a }),
      clear: () => set({ selectedTable: null, pendingAction: null }),
    }),
    { name: 'pos-order-context', version: 1 },
  ),
);


