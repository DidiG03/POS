export interface OfflineItem {
  id: string;
  payload: any;
}

export class OfflineQueue {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('pos-offline', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('orders', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.sync();
      });
      // Best-effort: flush any pending items on startup
      setTimeout(() => void this.sync(), 800);
    }
  }

  async enqueue(payload: any) {
    const db = await this.dbPromise;
    const tx = db.transaction('orders', 'readwrite');
    const store = tx.objectStore('orders');
    const item: OfflineItem = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, payload };
    store.put(item);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async getAll(): Promise<OfflineItem[]> {
    const db = await this.dbPromise;
    const tx = db.transaction('orders', 'readonly');
    const store = tx.objectStore('orders');
    const req = store.getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as OfflineItem[]);
      req.onerror = () => reject(req.error);
    });
  }

  private async remove(id: string) {
    const db = await this.dbPromise;
    const tx = db.transaction('orders', 'readwrite');
    tx.objectStore('orders').delete(id);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async sync() {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const items = await this.getAll();
    for (const item of items) {
      try {
        const payload = { ...(item.payload || {}), idempotencyKey: item.id };
        // IMPORTANT: set table open first so "openAt" exists before ticket/covers writes.
        try {
          if (payload?.area && payload?.tableLabel) {
            await window.api.tables.setOpen(String(payload.area), String(payload.tableLabel), true);
          }
        } catch {
          // ignore secondary sync ops
        }

        await window.api.tickets.log(payload);

        // Persist covers if provided (best-effort).
        try {
          const c = Number(payload?.covers);
          if (payload?.area && payload?.tableLabel && Number.isFinite(c) && c > 0) {
            await window.api.covers.save(String(payload.area), String(payload.tableLabel), c);
          }
        } catch {
          // ignore secondary sync ops
        }
        await this.remove(item.id);
      } catch {
        // stop on first failure and leave remaining items
        break;
      }
    }
  }
}

export const offlineQueue = new OfflineQueue();
