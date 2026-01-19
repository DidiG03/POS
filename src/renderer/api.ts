import { offlineQueue } from './utils/offlineQueue';

export interface TicketLinePayload {
  sku?: string;
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
    await window.api.tickets.log(payload);
  } catch {
    await offlineQueue.enqueue(payload);
  }
}
