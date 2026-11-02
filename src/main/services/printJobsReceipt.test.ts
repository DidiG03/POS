/** QA round 6, #9: a guest receipt that never printed is listed and can be printed again. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  dispatched: [] as any[],
  notifications: [] as any[],
  events: [] as any[],
}));

vi.mock('@db/client', () => ({
  prisma: {
    printJob: {
      findMany: vi.fn(async () => h.rows),
      findUnique: vi.fn(
        async ({ where }: any) => h.rows.find((r) => r.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) =>
        Object.assign(
          h.rows.find((r) => r.id === where.id),
          data,
        ),
      ),
    },
    user: {
      findUnique: vi.fn(async () => ({ displayName: 'Ana' })),
      findMany: vi.fn(async () => [{ id: 1 }]),
    },
    notification: {
      create: vi.fn(async ({ data }: any) => h.notifications.push(data)),
    },
  },
}));
vi.mock('./core', () => ({
  coreServices: { readSettings: async () => ({}) },
}));
vi.mock('./realtime', () => ({
  broadcastPrinterEvent: (e: any) => h.events.push(e),
}));
vi.mock('./printDispatcher', async () => {
  const real = await vi.importActual<any>('./printDispatcher');
  return {
    ...real,
    dispatchTicket: vi.fn(async (p: any) => {
      h.dispatched.push(p);
      return { ok: true };
    }),
    pickPrinterProfile: () => ({ name: 'Receipt' }),
  };
});

import { listStationPrintJobs, reprintStationPrintJob } from './printJobs';
import { notifyStationPrintFailed } from './printJobNotify';

const receipt = {
  id: 41,
  status: 'FAILED',
  attempts: 5,
  lastError: 'connection refused',
  printerProfileId: 'receipt',
  createdAt: new Date(),
  payloadJson: {
    area: 'Salla',
    tableLabel: 'T5',
    items: [{ name: 'Kafe', qty: 2 }],
    meta: { kind: 'PAYMENT', userId: 7, sentAtIso: new Date().toISOString() },
  },
};

describe('a guest receipt that never printed', () => {
  beforeEach(() => {
    h.rows = [structuredClone(receipt)];
    h.dispatched = [];
    h.notifications = [];
    h.events = [];
  });

  it('is listed under Printer jobs as a failed receipt', async () => {
    const jobs = await listStationPrintJobs({ userId: 7, role: 'WAITER' });
    expect(jobs).toEqual([
      expect.objectContaining({
        id: 41,
        status: 'FAILED',
        kind: 'receipt',
        tableLabel: 'T5',
      }),
    ]);
  });

  it('can be printed again, as the receipt (it never printed: not marked a reprint)', async () => {
    const r = await reprintStationPrintJob(41, { userId: 7, role: 'WAITER' });
    expect(r.ok).toBe(true);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].meta.kind).toBe('PAYMENT');
    expect(h.dispatched[0].meta.reprintOfIso).toBeUndefined();
    expect(h.rows[0].status).toBe('SENT');
  });

  it('once it has printed, every reprint is a marked copy, never a second original (QA v0.2.103 #5)', async () => {
    // First reprint: it never printed, so it goes out as the receipt.
    await reprintStationPrintJob(41, { userId: 7, role: 'WAITER' });
    expect(h.rows[0].status).toBe('SENT');
    // A manager reprints the printed job again.
    const r = await reprintStationPrintJob(41, { userId: 1, role: 'ADMIN' });
    expect(r.ok).toBe(true);
    expect(h.dispatched).toHaveLength(2);
    const second = h.dispatched[1];
    expect(second.meta.reprint).toBe(true);
    expect(second.meta.reprintOfIso).toBeTruthy();
    // Marked on paper as KOPJE / COPY.
    const { isReceiptCopy } = await import('../print');
    expect(isReceiptCopy('PAYMENT', second.meta)).toBe(true);
  });

  it('alerts the waiter and the till with what did not print', async () => {
    await notifyStationPrintFailed({
      payload: receipt.payloadJson,
      error: 'connection refused',
    });
    expect(h.events[0]).toMatchObject({
      level: 'error',
      kind: 'receipt',
      message: expect.stringContaining(
        'could not print the guest receipt for Salla T5',
      ),
    });
    expect(h.notifications.map((n) => n.userId).sort()).toEqual([1, 7]);
  });
});
