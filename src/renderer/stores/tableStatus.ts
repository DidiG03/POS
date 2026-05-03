import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tableKey } from '@shared/utils/tableKey';

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
        set((s) => {
          const now = Date.now();
          const ttlMs = 15000; // protect optimistic updates for 15s (cloud can be slow)
          const incoming: Record<string, boolean> = {};
          for (const e of entries || []) incoming[tableKey(e.area, e.label)] = true;
          const merged: Record<string, boolean> = {};
          // Start from server truth
          for (const k in incoming) merged[k] = true;
          // Preserve recent optimistic updates that the server hasn't caught up with yet
          for (const k in s.openMap) {
            const last = s.lastSetAt[k] || 0;
            const isRecent = now - last <= ttlMs;
            if (isRecent) {
              // Keep whatever the user set locally (open OR closed)
              merged[k] = s.openMap[k];
            }
          }
          // Clean up false entries
          for (const k in merged) {
            if (!merged[k]) delete merged[k];
          }
          return { openMap: merged } as any;
        }),
      reset: () => set({ openMap: {}, lastSetAt: {} }),
    }),
    { name: 'pos-table-status', version: 1 },
  ),
);


