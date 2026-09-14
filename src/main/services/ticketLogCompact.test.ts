import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));

import {
  compactTicketLogSession,
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
    await expect(compactTicketLogSession('k', client)).resolves.toBe(0);
  });
});
