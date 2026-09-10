import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tableKey } from '@shared/utils/tableKey';
import { dropOptimisticOpenState, mergeOpenTables } from './openTableMerge';

interface TableStatusState {
  openMap: Record<string, boolean>; // key = `${area}:${label}`
  lastSetAt: Record<string, number>;
  isOpen: (area: string, label: string) => boolean;
  setOpen: (area: string, label: string, open: boolean) => void;
  setAll: (entries: Array<{ area: string; label: string }>) => void;
  reset: () => void;
}

export const useTableStatus = create<TableStatusState>()(
  persist(
    (set, get) => ({
      openMap: {},
      lastSetAt: {},
      isOpen: (area, label) => Boolean(get().openMap[tableKey(area, label)]),
      setOpen: (area, label, open) =>
        set((s) => ({
          openMap: { ...s.openMap, [tableKey(area, label)]: open },
          lastSetAt: { ...s.lastSetAt, [tableKey(area, label)]: Date.now() },
        })),
      setAll: (entries) =>
        set((s) => ({
          openMap: mergeOpenTables({
            incoming: entries || [],
            openMap: s.openMap,
            lastSetAt: s.lastSetAt,
            keyOf: tableKey,
            offline:
              typeof navigator !== 'undefined' && navigator.onLine === false,
          }),
        })),
      reset: () => set({ openMap: {}, lastSetAt: {} }),
    }),
    {
      name: 'pos-table-status',
      version: 1,
      onRehydrateStorage: () => (state) => {
        if (state) useTableStatus.setState(dropOptimisticOpenState(state));
      },
    },
  ),
);
