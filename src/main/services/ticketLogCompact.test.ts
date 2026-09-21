import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));

import {
  compactTicketLogSession,
  compactOversizedTicketLogSessions,
  applyTicketLogSessionKeys,
  backfillAndCompactTicketLogs,
  ticketLogIdsToDrop,
  TICKET_LOG_KEEP_PER_SESSION,
} from './ticketLogCompact';

describe('ticketLogIdsToDrop', () => {
  it('keeps the newest snapshots of a sitting', () => {
    expect(ticketLogIdsToDrop([30, 20, 10, 5, 1])).toEqual([5, 1]);
    expect(ticketLogIdsToDrop([3, 2, 1])).toEqual([]);
    expect(TICKET_LOG_KEEP_PER_SESSION).toBe(3);
  });
});

describe('compactTicketLogSession', () => {
  it('deletes older snapshots for the same sessionKey', async () => {
    const deleted: unknown[] = [];
    const client = {
      ticketLog: {
        findMany: async () => [{ id: 30 }, { id: 20 }, { id: 10 }],
        deleteMany: async (args: unknown) => {
          deleted.push(args);
          return { count: 2 };
        },
      },
    };
    await expect(
      compactTicketLogSession('Salla:T7:session', client),
    ).resolves.toBe(2);
    expect(deleted[0]).toMatchObject({
      where: {
        sessionKey: 'Salla:T7:session',
        id: { notIn: [30, 20, 10] },
      },
    });
  });

  it('skips sittings that are still under the keep cap', async () => {
    const client = {
      ticketLog: {
        findMany: async () => [{ id: 2 }, { id: 1 }],
        deleteMany: async () => {
          throw new Error('should not delete');
        },
      },
    };
    await expect(compactTicketLogSession('A:1@t0', client)).resolves.toBe(0);
  });

  it('refuses an area-only leftover key so it cannot wipe the room', async () => {
    const client = {
      ticketLog: {
        findMany: async () => {
          throw new Error('should not compact Salla');
        },
        deleteMany: async () => {
          throw new Error('should not compact Salla');
        },
      },
    };
    await expect(compactTicketLogSession('Salla', client)).resolves.toBe(0);
    await expect(compactTicketLogSession('Veranda', client)).resolves.toBe(0);
  });
});

describe('compactOversizedTicketLogSessions', () => {
  it('compacts each distinct key once', async () => {
    const keys: string[] = [];
    const client = {
      ticketLog: {
        findMany: async (args: any) => {
          keys.push(String(args.where.sessionKey));
          return [{ id: 3 }, { id: 2 }, { id: 1 }];
        },
        deleteMany: async () => ({ count: 1 }),
      },
    };
    await expect(
      compactOversizedTicketLogSessions(['S1:a', 'S1:a', 'S2:a', ''], client),
    ).resolves.toBe(2);
    expect(keys).toEqual(['S1:a', 'S2:a']);
  });
});

describe('applyTicketLogSessionKeys', () => {
  it('updates only unkeyed rows, grouped by proposed key', async () => {
    const updates: unknown[] = [];
    const client = {
      ticketLog: {
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
        updateMany: async (args: any) => {
          updates.push(args);
          return { count: args.where.id.in.length };
        },
      },
    };
    const assignments = new Map<number, string>([
      [1, 'k-a'],
      [2, 'k-a'],
      [3, 'k-b'],
    ]);
    await expect(applyTicketLogSessionKeys(assignments, client)).resolves.toBe(
      3,
    );
    expect(updates).toHaveLength(2);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: {
            id: { in: [1, 2] },
          },
          data: { sessionKey: 'k-a' },
        }),
        expect.objectContaining({
          where: {
            id: { in: [3] },
          },
          data: { sessionKey: 'k-b' },
        }),
      ]),
    );
  });
});

describe('backfillAndCompactTicketLogs', () => {
  it('keys legacy rows then compact oversized sittings', async () => {
    const pizza = [{ name: 'Pizza', qty: 1, unitPrice: 10, sku: '', note: '' }];
    const pizzaCoke = [
      ...pizza,
      { name: 'Coke', qty: 1, unitPrice: 3, sku: '', note: '' },
    ];
    const client = {
      ticketLog: {
        findMany: async (args: any) => {
          if (args?.distinct) {
            return [{ area: 'A', tableLabel: '1' }];
          }
          if (args?.where?.sessionKey) {
            return [{ id: 4 }, { id: 3 }, { id: 2 }];
          }
          return [
            {
              id: 1,
              area: 'A',
              tableLabel: '1',
              sessionKey: null,
              createdAt: new Date(1_000),
              itemsJson: pizza,
            },
            {
              id: 2,
              area: 'A',
              tableLabel: '1',
              sessionKey: null,
              createdAt: new Date(2_000),
              itemsJson: pizzaCoke,
            },
            {
              id: 3,
              area: 'A',
              tableLabel: '1',
              sessionKey: null,
              createdAt: new Date(3_000),
              itemsJson: [
                ...pizzaCoke,
                { name: 'Coffee', qty: 1, unitPrice: 2, sku: '', note: '' },
              ],
            },
            {
              id: 4,
              area: 'A',
              tableLabel: '1',
              sessionKey: null,
              createdAt: new Date(4_000),
              itemsJson: [
                ...pizzaCoke,
                { name: 'Coffee', qty: 1, unitPrice: 2, sku: '', note: '' },
                { name: 'Water', qty: 1, unitPrice: 1, sku: '', note: '' },
              ],
            },
          ];
        },
        updateMany: async () => ({ count: 4 }),
        deleteMany: async () => ({ count: 1 }),
        groupBy: async () => [
          { sessionKey: 'A\u00001\u0000x', _count: { id: 4 } },
        ],
      },
    };
    await expect(backfillAndCompactTicketLogs(client)).resolves.toEqual({
      keyed: 4,
      compacted: 1,
    });
  });
});
