import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TableStatusState {
  openMap: Record<string, boolean>; // key = `${area}:${label}`
  lastSetAt: Record<string, number>;
  isOpen: (area: string, label: string) => boolean;
  setOpen: (area: string, label: string, open: boolean) => void;
  setAll: (entries: Array<{ area: string; label: string }>) => void;
  reset: () => void;
}

function key(area: string, label: string) {
  return `${area}:${label}`;
}

export const useTableStatus = create<TableStatusState>()(
  persist(
    (set, get) => ({
      openMap: {},
      lastSetAt: {},
      isOpen: (area, label) => Boolean(get().openMap[key(area, label)]),
      setOpen: (area, label, open) =>
        set((s) => ({
          openMap: { ...s.openMap, [key(area, label)]: open },
          lastSetAt: { ...s.lastSetAt, [key(area, label)]: Date.now() },
        })),
      setAll: (entries) =>
        set((s) => {
          const now = Date.now();
          const ttlMs = 4000; // protect optimistic updates for 4s
          const incoming: Record<string, boolean> = {};
          for (const e of entries || []) incoming[key(e.area, e.label)] = true;
          const merged: Record<string, boolean> = { ...s.openMap };
          // Set true for incoming open tables
          for (const k in incoming) {
            const last = s.lastSetAt[k] || 0;
            // If user just CLOSED a table locally, don't let a stale poll re-open it immediately.
            if (merged[k] === false && now - last <= ttlMs) continue;
            merged[k] = true;
          }
          // For keys not present in incoming, allow clearing only if not recently set locally
          for (const k in merged) {
            if (!incoming[k]) {
              const last = s.lastSetAt[k] || 0;
              if (now - last > ttlMs) delete merged[k];
            }
          }
          return { openMap: merged } as any;
        }),
      reset: () => set({ openMap: {}, lastSetAt: {} }),
    }),
    { name: 'pos-table-status', version: 1 },
  ),
);


