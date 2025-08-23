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
        const res = await fetch('http://localhost:3333/tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload),
        });
        if (!res.ok) throw new Error('bad response');
        await this.remove(item.id);
      } catch {
        // stop on first failure and leave remaining items
        break;
      }
    }
  }
}

export const offlineQueue = new OfflineQueue();
