import { afterEach, describe, expect, it } from 'vitest';
import {
  PRINT_JOB_KEEP_DAYS,
  printJobIdsToPurge,
  purgeSettledPrintJobs,
  shouldPurgePrintJob,
  startPrintJobRetentionLoop,
  stopPrintJobRetentionLoop,
  type PrintJobLedgerLinks,
  type PrintJobPurgeCandidate,
} from './printJobRetention';

const now = new Date('2026-09-16T12:00:00.000Z');
const cutoff = new Date('2026-09-09T12:00:00.000Z');
const old = new Date('2026-09-01T12:00:00.000Z');
const fresh = new Date('2026-09-12T12:00:00.000Z');
const emptyLinked: PrintJobLedgerLinks = {
  printJobIds: new Set(),
  idempotencyKeys: new Set(),
};

function job(
  partial: Partial<PrintJobPurgeCandidate> & { id: number },
): PrintJobPurgeCandidate {
  return {
    status: 'FAILED',
    createdAt: old,
    payloadJson: { meta: { kind: 'ORDER' } },
    ...partial,
  };
}

describe('shouldPurgePrintJob', () => {
  it('never deletes QUEUED or RETRY rows', () => {
    expect(
      shouldPurgePrintJob(job({ id: 1, status: 'QUEUED' }), {
        cutoff,
        linked: emptyLinked,
      }),
    ).toBe(false);
    expect(
      shouldPurgePrintJob(job({ id: 2, status: 'RETRY' }), {
        cutoff,
        linked: emptyLinked,
      }),
    ).toBe(false);
  });

  it('keeps jobs newer than the cutoff', () => {
    expect(
      shouldPurgePrintJob(job({ id: 3, createdAt: fresh, status: 'SENT' }), {
        cutoff,
        linked: emptyLinked,
      }),
    ).toBe(false);
  });

  it('deletes old kitchen FAILED / SENT slips', () => {
    expect(
      shouldPurgePrintJob(job({ id: 4, status: 'FAILED' }), {
        cutoff,
        linked: emptyLinked,
      }),
    ).toBe(true);
    expect(
      shouldPurgePrintJob(job({ id: 5, status: 'SENT' }), {
        cutoff,
        linked: emptyLinked,
      }),
    ).toBe(true);
  });

  it('deletes exhausted PAYMENT retries (not a ledger backfill source)', () => {
    expect(
      shouldPurgePrintJob(
        job({
          id: 7,
          status: 'FAILED',
          attempts: 5,
          payloadJson: { meta: { kind: 'PAYMENT' } },
        }),
        { cutoff, linked: emptyLinked },
      ),
    ).toBe(true);
  });

  it('keeps an old PAYMENT receipt until an Order exists', () => {
    const payment = job({
      id: 6,
      status: 'SENT',
      attempts: 0,
      idempotencyKey: 'pay-6',
      payloadJson: { meta: { kind: 'PAYMENT' } },
    });
    expect(shouldPurgePrintJob(payment, { cutoff, linked: emptyLinked })).toBe(
      false,
    );
    expect(
      shouldPurgePrintJob(payment, {
        cutoff,
        linked: {
          printJobIds: new Set([6]),
          idempotencyKeys: new Set(),
        },
      }),
    ).toBe(true);
    expect(
      shouldPurgePrintJob(payment, {
        cutoff,
        linked: {
          printJobIds: new Set(),
          idempotencyKeys: new Set(['pay-6']),
        },
      }),
    ).toBe(true);
  });
});

describe('printJobIdsToPurge', () => {
  it('returns only eligible ids', () => {
    expect(
      printJobIdsToPurge(
        [
          job({ id: 1, status: 'RETRY' }),
          job({ id: 2, status: 'FAILED' }),
          job({
            id: 3,
            status: 'SENT',
            payloadJson: { meta: { kind: 'PAYMENT' } },
          }),
          job({
            id: 4,
            status: 'FAILED',
            attempts: 5,
            payloadJson: { meta: { kind: 'PAYMENT' } },
          }),
        ],
        emptyLinked,
        cutoff,
      ),
    ).toEqual([2, 4]);
  });
});

describe('purgeSettledPrintJobs', () => {
  it('deletes eligible ids and leaves the sales-ledger backfill source', async () => {
    const deleted: unknown[] = [];
    const client = {
      printJob: {
        findMany: async (args: any) => {
          expect(args.where.status.in).toEqual(['SENT', 'FAILED']);
          expect(args.where.createdAt.lt).toEqual(cutoff);
          expect(args.where.id.gt).toBe(0);
          return [
            job({ id: 10, status: 'FAILED' }),
            job({
              id: 11,
              status: 'SENT',
              idempotencyKey: 'pay-11',
              payloadJson: { meta: { kind: 'PAYMENT' } },
            }),
            job({
              id: 12,
              status: 'SENT',
              idempotencyKey: 'pay-12',
              payloadJson: { meta: { kind: 'PAYMENT' } },
            }),
          ];
        },
        deleteMany: async (args: unknown) => {
          deleted.push(args);
          return { count: 2 };
        },
      },
      order: {
        findMany: async () => [{ printJobId: 12, idempotencyKey: 'pay-12' }],
      },
    };

    await expect(
      purgeSettledPrintJobs(client, { days: PRINT_JOB_KEEP_DAYS, now }),
    ).resolves.toBe(2);
    expect(deleted[0]).toMatchObject({ where: { id: { in: [10, 12] } } });
  });

  it('does not call delete when every leftover job is a payment without an Order', async () => {
    const client = {
      printJob: {
        findMany: async () => [
          job({
            id: 20,
            status: 'SENT',
            payloadJson: { meta: { kind: 'PAYMENT' } },
          }),
        ],
        deleteMany: async () => {
          throw new Error('should not delete');
        },
      },
      order: { findMany: async () => [] },
    };
    await expect(purgeSettledPrintJobs(client, { days: 7, now })).resolves.toBe(
      0,
    );
  });
});

describe('print job retention loop', () => {
  afterEach(() => {
    stopPrintJobRetentionLoop();
  });

  it('is safe to start twice and stop when idle', () => {
    const prisma = {
      printJob: {
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
      },
      order: { findMany: async () => [] },
    } as any;
    startPrintJobRetentionLoop(prisma, { days: 7, intervalMs: 60_000 });
    startPrintJobRetentionLoop(prisma, { days: 7, intervalMs: 60_000 });
    stopPrintJobRetentionLoop();
    stopPrintJobRetentionLoop();
  });
});
