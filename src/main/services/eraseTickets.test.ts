import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./floorSnapshot', () => ({
  invalidateFloorSnapshotCache: vi.fn(),
}));
vi.mock('./realtime', () => ({
  broadcastTableStatusChanged: vi.fn(),
}));
vi.mock('@db/client', () => ({ prisma: {} }));

import { invalidateFloorSnapshotCache } from './floorSnapshot';
import { broadcastTableStatusChanged } from './realtime';
import {
  ERASE_TICKETS_CONFIRM,
  eraseAllTickets,
  eraseTicketsConfirmMatches,
} from './eraseTickets';
import { LEDGER_ERASED_THROUGH_KEY } from './ledgerErase';

function fakeClient(newestJobId = 0) {
  const calls: string[] = [];
  const upserts: any[] = [];
  const count = (name: string, n = 0) => ({
    deleteMany: async () => {
      calls.push(name);
      return { count: n };
    },
  });
  return {
    calls,
    upserts,
    kdsTicketStation: count('kdsTicketStation'),
    kdsTicket: count('kdsTicket'),
    kdsOrder: count('kdsOrder', 2),
    kdsDayCounter: count('kdsDayCounter'),
    orderItemModifier: count('orderItemModifier'),
    orderItem: count('orderItem'),
    payment: count('payment'),
    saleCorrection: count('saleCorrection'),
    order: count('order', 4),
    ticketLog: count('ticketLog', 7),
    ticketRequest: count('ticketRequest'),
    covers: count('covers'),
    tableOccupancy: {
      findMany: async () => [{ area: 'Salla', label: 'T15' }],
      deleteMany: async () => {
        calls.push('tableOccupancy');
        return { count: 1 };
      },
    },
    printJob: {
      findFirst: async () => (newestJobId ? { id: newestJobId } : null),
    },
    syncState: {
      deleteMany: async () => {
        calls.push('syncState');
        return { count: 0 };
      },
      upsert: async (args: any) => {
        upserts.push(args);
        return {};
      },
    },
  };
}

describe('eraseTicketsConfirmMatches', () => {
  it('accepts ERASE in any case with surrounding space', () => {
    expect(eraseTicketsConfirmMatches('ERASE')).toBe(true);
    expect(eraseTicketsConfirmMatches(' erase ')).toBe(true);
    expect(eraseTicketsConfirmMatches(ERASE_TICKETS_CONFIRM)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(eraseTicketsConfirmMatches('')).toBe(false);
    expect(eraseTicketsConfirmMatches('YES')).toBe(false);
    expect(eraseTicketsConfirmMatches('ERASE ALL')).toBe(false);
  });
});

describe('eraseAllTickets', () => {
  beforeEach(() => {
    vi.mocked(invalidateFloorSnapshotCache).mockClear();
    vi.mocked(broadcastTableStatusChanged).mockClear();
  });

  it('deletes kitchen, sale, and occupancy rows in child-first order', async () => {
    const client = fakeClient();
    const result = await eraseAllTickets(client as any);
    expect(result).toEqual({
      ok: true,
      ticketLogs: 7,
      orders: 4,
      kdsOrders: 2,
      openTables: 1,
    });
    expect(client.calls[0]).toBe('kdsTicketStation');
    expect(client.calls.indexOf('orderItemModifier')).toBeLessThan(
      client.calls.indexOf('orderItem'),
    );
    expect(client.calls.indexOf('orderItem')).toBeLessThan(
      client.calls.indexOf('order'),
    );
    expect(client.calls.indexOf('ticketLog')).toBeLessThan(
      client.calls.indexOf('tableOccupancy'),
    );
    expect(invalidateFloorSnapshotCache).toHaveBeenCalledTimes(1);
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Salla',
      label: 'T15',
      open: false,
    });
  });

  it('marks existing print jobs so boot cannot rebuild the erased sales', async () => {
    const client = fakeClient(42);
    await eraseAllTickets(client as any);
    expect(client.upserts).toHaveLength(1);
    expect(client.upserts[0]).toMatchObject({
      where: { key: LEDGER_ERASED_THROUGH_KEY },
      update: { valueJson: { printJobId: 42 } },
    });
  });

  it('writes no mark when there are no print jobs', async () => {
    const client = fakeClient(0);
    await eraseAllTickets(client as any);
    expect(client.upserts).toHaveLength(0);
  });
});
