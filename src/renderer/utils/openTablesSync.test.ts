import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
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

describe('applyHostOpenTables', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not wipe a just-transferred bill when the poll is still stale', async () => {
    const { useTableStatus } = await import('../stores/tableStatus');
    const { useTicketStore } = await import('../stores/ticket');
    const { applyHostOpenTables } = await import('./openTablesSync');

    useTicketStore.getState().bindTable('Main:T1', { keepLiveBill: true });
    useTicketStore.getState().addItem({
      sku: 'soup',
      name: 'Soup',
      unitPrice: 5,
    });
    useTicketStore.getState().markLinesAsSent(
      useTicketStore.getState().lines.map((l) => l.id),
      'send-1',
    );
    useTableStatus.getState().setOpen('Main', 'T4', false);
    useTableStatus.getState().setOpen('Main', 'T1', true);

    applyHostOpenTables([{ area: 'Main', label: 'T4' }]);

    expect(useTableStatus.getState().isOpen('Main', 'T1')).toBe(true);
    expect(useTicketStore.getState().boundKey).toBe('Main:T1');
    expect(useTicketStore.getState().lines).toHaveLength(1);
  });
});
