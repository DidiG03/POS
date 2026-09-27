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

import { decideTicketRequest } from './ticketRequests';

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
