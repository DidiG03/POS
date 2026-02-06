import { create } from 'zustand';
import { ticketLineId } from '@shared/utils/ticketLineId';

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
  addItem: (_input: { sku: string; name: string; unitPrice: number; vatRate?: number }) => void;
  increment: (_id: string) => void;
  decrement: (_id: string) => void;
  removeLine: (_id: string) => void;
  setLineNote: (_id: string, _note: string) => void;
  setOrderNote: (_note: string) => void;
  hydrate: (_payload: { items: { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string }[]; note?: string | null }) => void;
  clear: () => void;
}

export const useTicketStore = create<TicketState>((set, _get) => ({
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
      const id = ticketLineId(sku);
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
  removeLine: (id) => set((s) => ({ lines: s.lines.filter((l) => l.id !== id) })),
  setLineNote: (id, note) => set((s) => ({ lines: s.lines.map((l) => (l.id === id ? { ...l, note } : l)) })),
  setOrderNote: (note) => set({ orderNote: note }),
  hydrate: ({ items, note }) =>
    set(() => ({
      lines: (items || []).map((it) => ({
        id: ticketLineId(it.name),
        sku: it.name, // fallback if sku not logged; could be improved to store sku in log
        name: it.name,
        unitPrice: Number(it.unitPrice),
        vatRate: Number(it.vatRate ?? 0),
        qty: Number(it.qty || 1),
        note: it.note,
      })),
      orderNote: note || '',
    })),
  clear: () => set({ lines: [] }),
}));


