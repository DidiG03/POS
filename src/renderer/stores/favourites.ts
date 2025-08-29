import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface FavouritesState {
  byUser: Record<string, string[]>; // userId -> sku[]
  toggle: (userId: number, sku: string) => void;
  isFav: (userId: number | null | undefined, sku: string) => boolean;
  list: (userId: number | null | undefined) => string[];
}

export const useFavourites = create<FavouritesState>()(
  persist(
    (set, get) => ({
      byUser: {},
      toggle: (userId: number, sku: string) =>
        set((s) => {
          const key = String(userId);
          const current = s.byUser[key] || [];
          const has = current.includes(sku);
          const next = has ? current.filter((x) => x !== sku) : [...current, sku];
          return { byUser: { ...s.byUser, [key]: next } };
        }),
      isFav: (userId, sku) => {
        if (!userId) return false;
        const key = String(userId);
        return (get().byUser[key] || []).includes(sku);
      },
      list: (userId) => {
        if (!userId) return [];
        const key = String(userId);
        return get().byUser[key] || [];
      },
    }),
    { name: 'pos-favourites', version: 1 },
  ),
);


