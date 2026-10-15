import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requests, notifications, ticketLogWrites } = vi.hoisted(() => ({
  requests: new Map<number, any>(),
  notifications: [] as any[],
  ticketLogWrites: [] as any[],
}));

vi.mock('@db/client', () => ({
  prisma: {
    ticketRequest: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        const r = requests.get(where.id);
        if (!r || r.ownerId !== where.ownerId || r.status !== where.status) {
          return { count: 0 };
        }
        Object.assign(r, data);
        return { count: 1 };
      }),
      findUnique: vi.fn(
        async ({ where }: any) => requests.get(where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        [...requests.values()]
          .filter(
            (r) =>
              r.requesterId === where.requesterId &&
              r.ownerId === where.ownerId &&
              r.area === where.area &&
              r.tableLabel === where.tableLabel &&
              r.status === where.status &&
              r.createdAt >= where.createdAt.gte,
          )
          .reverse(),
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: requests.size + 100, createdAt: new Date(), ...data };
        requests.set(row.id, row);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: 3, displayName: 'Ana' })),
    },
    notification: {
      create: vi.fn(async ({ data }: any) => {
        notifications.push(data);
        return data;
      }),
    },
    ticketLog: {
      create: vi.fn(async ({ data }: any) => {
        ticketLogWrites.push(data);
        return data;
      }),
    },
  },
}));

import { createTicketRequest, decideTicketRequest } from './ticketRequests';

describe('decideTicketRequest', () => {
  beforeEach(() => {
    requests.clear();
    notifications.length = 0;
    ticketLogWrites.length = 0;
    requests.set(5, {
      id: 5,
      requesterId: 3,
      ownerId: 7,
      area: 'Salla',
      tableLabel: 'T4',
      status: 'PENDING',
    });
  });

  it('approves and tells the requester, without touching the bill', async () => {
    expect(
      await decideTicketRequest({ id: 5, ownerId: 7, decision: 'APPROVED' }),
    ).toBe(true);
    expect(requests.get(5).status).toBe('APPROVED');
    expect(notifications).toEqual([
      expect.objectContaining({
        userId: 3,
        message: 'Your request #5 on Salla T4 was approved',
      }),
    ]);
    // The owner's order screen adds the items; the host must not rewrite
    // the ticket (that is what stripped paid/voided flags).
    expect(ticketLogWrites).toHaveLength(0);
  });

  it('rejects', async () => {
    expect(
      await decideTicketRequest({ id: 5, ownerId: 7, decision: 'REJECTED' }),
    ).toBe(true);
    expect(requests.get(5).status).toBe('REJECTED');
    expect(notifications[0].message).toContain('was rejected');
  });

  it('refuses a request addressed to someone else', async () => {
    expect(
      await decideTicketRequest({ id: 5, ownerId: 8, decision: 'APPROVED' }),
    ).toBe(false);
    expect(requests.get(5).status).toBe('PENDING');
    expect(notifications).toHaveLength(0);
  });

  it('decides a request only once', async () => {
    await decideTicketRequest({ id: 5, ownerId: 7, decision: 'APPROVED' });
    expect(
      await decideTicketRequest({ id: 5, ownerId: 7, decision: 'REJECTED' }),
    ).toBe(false);
    expect(requests.get(5).status).toBe('APPROVED');
    expect(notifications).toHaveLength(1);
  });

  it('ignores a missing or invalid id', async () => {
    expect(
      await decideTicketRequest({ id: 99, ownerId: 7, decision: 'APPROVED' }),
    ).toBe(false);
    expect(
      await decideTicketRequest({ id: 0, ownerId: 7, decision: 'APPROVED' }),
    ).toBe(false);
  });
});

describe('createTicketRequest', () => {
  const ask = {
    requesterId: 3,
    ownerId: 5,
    area: 'Salla',
    tableLabel: '4',
    items: [{ name: 'Kafe', qty: 2 }],
    note: null,
  };

  beforeEach(() => {
    requests.clear();
    notifications.length = 0;
  });

  it('records the request and tells the owner', async () => {
    const r = await createTicketRequest(ask);
    expect(r.created).toBe(true);
    expect(notifications).toEqual([
      expect.objectContaining({
        userId: 5,
        message: expect.stringContaining(
          'Ana requested to add items on Salla 4',
        ),
      }),
    ]);
  });

  it('a retried POST does not create a second request', async () => {
    const first = await createTicketRequest(ask);
    const again = await createTicketRequest(ask);
    expect(again).toEqual({ id: first.id, created: false });
    expect(requests.size).toBe(1);
    expect(notifications).toHaveLength(1);
  });

  it('a different order from the same waiter is a new request', async () => {
    await createTicketRequest(ask);
    await createTicketRequest({ ...ask, items: [{ name: 'Uje', qty: 1 }] });
    expect(requests.size).toBe(2);
  });
});
