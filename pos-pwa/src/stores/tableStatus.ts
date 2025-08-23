import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TableStatusState {
  openMap: Record<string, boolean>; // key = `${area}:${label}`
  isOpen: (_area: string, _label: string) => boolean;
  setOpen: (_area: string, _label: string, _open: boolean) => void;
  reset: () => void;
}

function key(area: string, label: string) {
  return `${area}:${label}`;
}

export const useTableStatus = create<TableStatusState>()(
  persist(
    (set, get) => ({
      openMap: {},
      isOpen: (area, label) => Boolean(get().openMap[key(area, label)]),
      setOpen: (area, label, open) =>
        set((s) => ({ openMap: { ...s.openMap, [key(area, label)]: open } })),
      reset: () => set({ openMap: {} }),
    }),
    { name: 'pos-table-status', version: 1 },
  ),
);


