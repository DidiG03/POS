import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: {
    erasedThrough: 0,
    jobs: [] as any[],
    orders: [] as any[],
  },
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: vi.fn(async () =>
        db.erasedThrough
          ? { valueJson: { printJobId: db.erasedThrough } }
          : null,
      ),
    },
    printJob: {
      findMany: vi.fn(async ({ where, take }: any) =>
        db.jobs.filter((j) => !where.id || j.id > where.id.gt).slice(0, take),
      ),
    },
    order: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
  },
}));
vi.mock('./core', () => ({
  coreServices: { readSettings: vi.fn(async () => ({})) },
}));
vi.mock('./license', () => ({ storePlanBlocksTables: () => false }));
vi.mock('./menuStock', () => ({
  consumeMenuStockForTicketLines: vi.fn(),
  stockLinesFromTicketItems: vi.fn(() => []),
}));

import * as ledger from './salesLedger';

const paymentJob = (id: number) => ({
  id,
  attempts: 0,
  createdAt: new Date('2026-09-20T12:00:00Z'),
  idempotencyKey: `pay-${id}`,
  payloadJson: {
    area: 'Salla',
    tableLabel: 'T1',
    items: [{ name: 'Espresso', qty: 1, unitPrice: 1.5, vatRate: 0.2 }],
    meta: { kind: 'PAYMENT' },
  },
});

describe('sales ledger after "Erase tickets"', () => {
  beforeEach(() => {
    db.erasedThrough = 0;
    db.jobs = [];
  });

  it('boot backfill starts after the erase mark', async () => {
    // #7 is a kitchen slip, so the scan counts it without writing a sale.
    db.jobs = [
      paymentJob(5),
      paymentJob(6),
      { ...paymentJob(7), payloadJson: { meta: { kind: 'ORDER' } } },
    ];
    db.erasedThrough = 6;
    await expect(ledger.backfillSalesLedgerFromPrintJobs()).resolves.toEqual({
      scanned: 1,
      written: 0,
    });
  });

  it('a replayed payment from before the erase does not recreate its sale', async () => {
    db.erasedThrough = 6;
    await expect(
      ledger.ensureSettledSaleFromPrintJob(paymentJob(6), {}),
    ).resolves.toBeNull();
  });
});
