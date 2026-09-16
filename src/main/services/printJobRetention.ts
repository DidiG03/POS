/**
 * PrintJob is the printer queue, not the sales ledger.
 *
 * SENT / FAILED rows keep a full ticket JSON after the slip has already
 * printed (or given up). Revenue, covers, and Review read Order / Payment.
 * Keeping those dead jobs is what bloated the till file.
 *
 * QUEUED and RETRY stay — those still need a printer. First-print PAYMENT
 * receipts (attempts = 0) with no Order stay — boot backfill still
 * reconstructs the sale from them. Exhausted retries are just extra JSON.
 */
import type { PrismaClient } from '@prisma/client';
import { isPaymentPayload } from '@shared/salesLedger';

export const PRINT_JOB_KEEP_DAYS = 7;
export const PRINT_JOB_PURGE_BATCH = 500;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

const PURGEABLE_STATUS = new Set(['SENT', 'FAILED']);
const ACTIVE_STATUS = new Set(['QUEUED', 'RETRY']);

export type PrintJobPurgeCandidate = {
  id: number;
  status: string;
  createdAt: Date | string | number;
  attempts?: number | null;
  idempotencyKey?: string | null;
  payloadJson?: unknown;
};

export type PrintJobLedgerLinks = {
  printJobIds: Set<number>;
  idempotencyKeys: Set<string>;
};

let timer: NodeJS.Timeout | null = null;

export function printJobCreatedAtMs(
  createdAt: PrintJobPurgeCandidate['createdAt'],
): number {
  if (createdAt instanceof Date) return createdAt.getTime();
  if (typeof createdAt === 'number') {
    return Number.isFinite(createdAt) ? createdAt : NaN;
  }
  const t = Date.parse(String(createdAt || ''));
  return Number.isFinite(t) ? t : NaN;
}

export function printJobHasLedgerRow(
  job: Pick<PrintJobPurgeCandidate, 'id' | 'idempotencyKey'>,
  linked: PrintJobLedgerLinks,
): boolean {
  if (linked.printJobIds.has(Number(job.id))) return true;
  const key = String(job.idempotencyKey || '').trim();
  return key ? linked.idempotencyKeys.has(key) : false;
}

/** Same filter as sales-ledger backfill: first-print PAYMENT receipts only. */
export function isSalesLedgerBackfillSource(
  job: Pick<PrintJobPurgeCandidate, 'attempts' | 'payloadJson'>,
): boolean {
  if (!isPaymentPayload(job.payloadJson)) return false;
  return Number(job.attempts || 0) === 0;
}

/**
 * True when this row is safe to delete: old SENT/FAILED, and either not a
 * payment receipt or the sale already exists on Order.
 */
export function shouldPurgePrintJob(
  job: PrintJobPurgeCandidate,
  args: { cutoff: Date; linked: PrintJobLedgerLinks },
): boolean {
  const status = String(job.status || '').toUpperCase();
  if (ACTIVE_STATUS.has(status)) return false;
  if (!PURGEABLE_STATUS.has(status)) return false;
  const t = printJobCreatedAtMs(job.createdAt);
  if (!Number.isFinite(t) || t >= args.cutoff.getTime()) return false;
  if (
    isSalesLedgerBackfillSource(job) &&
    !printJobHasLedgerRow(job, args.linked)
  ) {
    return false;
  }
  return true;
}

export function printJobIdsToPurge(
  jobs: PrintJobPurgeCandidate[],
  linked: PrintJobLedgerLinks,
  cutoff: Date,
): number[] {
  const out: number[] = [];
  for (const job of jobs) {
    if (!shouldPurgePrintJob(job, { cutoff, linked })) continue;
    const id = Number(job.id);
    if (Number.isInteger(id) && id > 0) out.push(id);
  }
  return out;
}

type RetentionClient = {
  printJob: {
    findMany: (args: unknown) => Promise<PrintJobPurgeCandidate[]>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  order: {
    findMany: (args: unknown) => Promise<
      Array<{
        printJobId?: number | null;
        idempotencyKey?: string | null;
      }>
    >;
  };
};

async function ledgerLinksFor(
  client: RetentionClient,
  jobs: PrintJobPurgeCandidate[],
): Promise<PrintJobLedgerLinks> {
  const ids = jobs.map((j) => Number(j.id)).filter((n) => n > 0);
  const keys = jobs
    .map((j) => String(j.idempotencyKey || '').trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return { printJobIds: new Set(), idempotencyKeys: new Set() };
  }
  const or: Array<Record<string, unknown>> = [{ printJobId: { in: ids } }];
  if (keys.length > 0) or.push({ idempotencyKey: { in: keys } });
  const orders = await client.order
    .findMany({
      where: { OR: or },
      select: { printJobId: true, idempotencyKey: true },
    })
    .catch(() => []);
  const printJobIds = new Set<number>();
  const idempotencyKeys = new Set<string>();
  for (const o of orders) {
    const jobId = Number(o?.printJobId);
    if (Number.isInteger(jobId) && jobId > 0) printJobIds.add(jobId);
    const key = String(o?.idempotencyKey || '').trim();
    if (key) idempotencyKeys.add(key);
  }
  return { printJobIds, idempotencyKeys };
}

/** Deletes old SENT/FAILED print jobs. Active queue rows are never touched. */
export async function purgeSettledPrintJobs(
  client: RetentionClient,
  opts: { days?: number; now?: Date; batchSize?: number } = {},
): Promise<number> {
  const days = Math.max(
    1,
    Number.isFinite(Number(opts.days))
      ? Number(opts.days)
      : PRINT_JOB_KEEP_DAYS,
  );
  const now = opts.now || new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const batchSize = Math.min(
    500,
    Math.max(50, Number(opts.batchSize) || PRINT_JOB_PURGE_BATCH),
  );

  let purged = 0;
  let cursor = 0;
  for (let i = 0; i < 20; i++) {
    const jobs = (await client.printJob.findMany({
      where: {
        status: { in: ['SENT', 'FAILED'] as any },
        createdAt: { lt: cutoff },
        id: { gt: cursor },
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        status: true,
        createdAt: true,
        attempts: true,
        idempotencyKey: true,
        payloadJson: true,
      },
    })) as PrintJobPurgeCandidate[];
    if (!jobs.length) break;
    cursor = Number(jobs[jobs.length - 1]?.id) || cursor;
    if (!(cursor > 0)) break;

    const ids = printJobIdsToPurge(
      jobs,
      await ledgerLinksFor(client, jobs),
      cutoff,
    );
    if (ids.length > 0) {
      const res = await client.printJob.deleteMany({
        where: { id: { in: ids } },
      });
      purged += Number(res?.count || 0);
    }
    if (jobs.length < batchSize) break;
  }
  return purged;
}

async function cleanupOnce(prisma: PrismaClient, days: number) {
  const count = await purgeSettledPrintJobs(prisma as RetentionClient, {
    days,
  });
  if (count > 0) {
    console.log(
      `[PrintJob] Deleted ${count} SENT/FAILED job(s) older than ${days}d`,
    );
  }
}

export type PrintJobRetentionOptions = {
  days?: number;
  intervalMs?: number;
};

export function startPrintJobRetentionLoop(
  prisma: PrismaClient,
  opts: PrintJobRetentionOptions = {},
) {
  if (timer) return;
  const days = Number.isFinite(Number(opts.days))
    ? Number(opts.days)
    : PRINT_JOB_KEEP_DAYS;
  const intervalMs = Number.isFinite(Number(opts.intervalMs))
    ? Number(opts.intervalMs)
    : DEFAULT_INTERVAL_MS;

  cleanupOnce(prisma, Math.max(1, days)).catch(() => {});
  timer = setInterval(
    () => {
      cleanupOnce(prisma, Math.max(1, days)).catch(() => {});
    },
    Math.max(60_000, intervalMs),
  );
}

export function stopPrintJobRetentionLoop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
