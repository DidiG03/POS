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
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  categoryId?: number;
  categoryName?: string;
  // When true, this line was added locally in the current session (not from last logged ticket)
  staged?: boolean;
}

interface TicketState {
  lines: TicketLine[];
  orderNote: string;
  addItem: (input: { sku: string; name: string; unitPrice: number; vatRate?: number; qty?: number; station?: 'KITCHEN' | 'BAR' | 'DESSERT'; categoryId?: number; categoryName?: string }) => void;
  increment: (id: string) => void;
  decrement: (id: string) => void;
  removeLine: (id: string) => void;
  setLineNote: (id: string, note: string) => void;
  setOrderNote: (note: string) => void;
  hydrate: (payload: { items: { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string }[]; note?: string | null }) => void;
  clear: () => void;
  markAllAsSent: () => void;
}

export const useTicketStore = create<TicketState>((set, _get) => ({
  lines: [],
  orderNote: '',
  addItem: ({ sku, name, unitPrice, vatRate = 0.2, qty, station, categoryId, categoryName }) => {
    set((state) => {
      if (qty != null && Number.isFinite(qty)) {
        const id = ticketLineId(sku);
        const line: TicketLine = { id, sku, name, unitPrice, vatRate, qty: Number(qty), staged: true, station, categoryId, categoryName };
        return { lines: [...state.lines, line] };
      }
      const existing = state.lines.find((l) => l.sku === sku && l.staged === true);
      if (existing) {
        return {
          lines: state.lines.map((l) => (l.id === existing.id ? { ...l, qty: l.qty + 1 } : l)),
        };
      }
      const id = ticketLineId(sku);
      const line: TicketLine = { id, sku, name, unitPrice, vatRate, qty: 1, staged: true, station, categoryId, categoryName };
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
        staged: false,
      })),
      orderNote: note || '',
    })),
  clear: () => set({ lines: [] }),
  markAllAsSent: () => set((s) => ({ lines: s.lines.map((l) => ({ ...l, staged: false })) })),
}));


