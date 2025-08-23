import { offlineQueue } from './utils/offlineQueue';

export interface TicketLinePayload {
  name: string;
  qty: number;
  unitPrice: number;
  vatRate?: number;
  note?: string;
}

export interface TicketPayload {
  userId: number;
  area: string;
  tableLabel: string;
  covers?: number | null;
  items: TicketLinePayload[];
  note?: string;
}

export async function logTicket(payload: TicketPayload) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await offlineQueue.enqueue(payload);
    return;
  }
  try {
    const res = await fetch('http://localhost:3333/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('bad response');
  } catch {
    await offlineQueue.enqueue(payload);
  }
}
