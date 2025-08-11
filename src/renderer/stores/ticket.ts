import { create } from 'zustand';

export interface TicketLine {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  vatRate: number; // 0.2 = 20%
  qty: number;
  note?: string;
}

interface TicketState {
  lines: TicketLine[];
  orderNote: string;
  addItem: (input: { sku: string; name: string; unitPrice: number; vatRate?: number }) => void;
  increment: (id: string) => void;
  decrement: (id: string) => void;
  setLineNote: (id: string, note: string) => void;
  setOrderNote: (note: string) => void;
  clear: () => void;
}

export const useTicketStore = create<TicketState>((set, get) => ({
  lines: [],
  orderNote: '',
  addItem: ({ sku, name, unitPrice, vatRate = 0.2 }) => {
    set((state) => {
      const existing = state.lines.find((l) => l.sku === sku);
      if (existing) {
        return {
          lines: state.lines.map((l) => (l.id === existing.id ? { ...l, qty: l.qty + 1 } : l)),
        };
      }
      const id = `${sku}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const line: TicketLine = { id, sku, name, unitPrice, vatRate, qty: 1 };
      return { lines: [...state.lines, line] };
    });
  },
  increment: (id) => set((s) => ({ lines: s.lines.map((l) => (l.id === id ? { ...l, qty: l.qty + 1 } : l)) })),
  decrement: (id) =>
    set((s) => ({
      lines: s.lines
        .map((l) => (l.id === id ? { ...l, qty: Math.max(0, l.qty - 1) } : l))
        .filter((l) => l.qty > 0),
    })),
  setLineNote: (id, note) => set((s) => ({ lines: s.lines.map((l) => (l.id === id ? { ...l, note } : l)) })),
  setOrderNote: (note) => set({ orderNote: note }),
  clear: () => set({ lines: [] }),
}));


