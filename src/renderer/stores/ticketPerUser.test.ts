import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(seed: Record<string, unknown> = {}): Storage {
  const data = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

const waiter = (id: number, displayName: string) =>
  ({
    id,
    displayName,
    role: 'WAITER',
    active: true,
    createdAt: new Date().toISOString(),
  }) as any;

// QA round 4, #3: one phone, the requester signs out, the owner signs in.
describe('ticket carts are per waiter', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the owner does not see the requester's requested lines", async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const { useSessionStore } = await import('./session');
    const { useTicketStore } = await import('./ticket');
    useSessionStore.getState().setUser(waiter(8, 'Ben'));
    useTicketStore.getState().bindTable('Salla\u0001Q30');
    useTicketStore.getState().addItem({
      sku: 'COLA',
      name: 'Cola',
      unitPrice: 2.5,
      qty: 2,
    });
    expect(useTicketStore.getState().lines).toHaveLength(1);

    useSessionStore.getState().setUser(null);
    useSessionStore.getState().setUser(waiter(7, 'Ana'));
    useTicketStore.getState().bindTable('Salla\u0001Q30');
    expect(useTicketStore.getState().lines).toEqual([]);

    // Ben's request is his again when he signs back in.
    useSessionStore.getState().setUser(waiter(8, 'Ben'));
    useTicketStore.getState().bindTable('Salla\u0001Q30');
    expect(useTicketStore.getState().lines.map((l) => l.sku)).toEqual(['COLA']);
  });
});
