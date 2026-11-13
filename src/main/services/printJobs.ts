/**
 * Kitchen slips and guest receipts that have not printed, for staff to see
 * and print again.
 *
 * A slip stuck in the retry queue, or given up on, was only visible in the
 * database. Staff now see them under Printer jobs (notifications panel) and
 * can print one again, marked REPRINT with the time it was first sent. A
 * guest receipt that never printed was left out of the list entirely (QA
 * round 6, #9); it is listed too, and printed again as the receipt itself
 * (it never printed, so it is not a copy).
 */
import { prisma } from '@db/client';
import { coreServices } from './core';
import {
  dispatchTicket,
  isGuestReceipt,
  pickPrinterProfile,
  printJobIsWatched,
} from './printDispatcher';
import { logIgnored } from './logIgnored';

export const PRINT_JOBS_LOOKBACK_MS = 12 * 60 * 60_000;

export type StationPrintJobDTO = {
  id: number;
  status: 'RETRY' | 'FAILED';
  attempts: number;
  lastError: string | null;
  printerName: string | null;
  area: string;
  tableLabel: string;
  items: Array<{ name: string; qty: number }>;
  voidSlip: boolean;
  /** `receipt` for a guest receipt, bill or corrective slip. */
  kind: 'order' | 'receipt';
  sentAt: string;
  userId: number | null;
};

export type PrintJobActor = { userId: number; role?: string | null };

function isManager(actor: PrintJobActor): boolean {
  return String(actor.role || '').toUpperCase() === 'ADMIN';
}

/**
 * Who may reprint a job: the waiter who sent it, or an admin. Anyone else
 * could put a colleague's (or an already printed) order through the
 * kitchen again. A job that already printed is for an admin only.
 */
export function reprintAllowed(input: {
  actor: PrintJobActor;
  jobUserId: number | null;
  status: string;
}): boolean {
  if (isManager(input.actor)) return true;
  if (String(input.status) === 'SENT') return false;
  return (
    input.jobUserId != null &&
    Number(input.jobUserId) === Number(input.actor.userId)
  );
}

/**
 * Kitchen slips still waiting to print or given up on, newest first. A
 * waiter sees their own; an admin sees every one.
 */
export async function listStationPrintJobs(
  actor?: PrintJobActor,
  now = Date.now(),
): Promise<StationPrintJobDTO[]> {
  const rows = (await prisma.printJob
    .findMany({
      where: {
        status: { in: ['RETRY', 'FAILED'] as any },
        createdAt: { gte: new Date(now - PRINT_JOBS_LOOKBACK_MS) },
        printerProfileId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    } as any)
    .catch(logIgnored('printJobs:81', []))) as any[];
  const settings = await coreServices.readSettings().catch(() => ({}));
  const out: StationPrintJobDTO[] = [];
  for (const r of rows) {
    const p = (r.payloadJson || {}) as any;
    if (!printJobIsWatched(p)) continue;
    if (
      actor &&
      !isManager(actor) &&
      Number(p?.meta?.userId) !== Number(actor.userId)
    ) {
      continue;
    }
    out.push({
      id: Number(r.id),
      status: String(r.status) === 'RETRY' ? 'RETRY' : 'FAILED',
      attempts: Number(r.attempts || 0),
      lastError: r.lastError ? String(r.lastError) : null,
      printerName:
        pickPrinterProfile(settings as any, String(r.printerProfileId || ''))
          ?.name ?? null,
      area: String(p.area || ''),
      tableLabel: String(p.tableLabel || ''),
      items: (Array.isArray(p.items) ? p.items : []).map((it: any) => ({
        name: String(it?.name || ''),
        qty: Number(it?.qty) || 1,
      })),
      voidSlip: Boolean(p?.meta?.voidSlip),
      kind: isGuestReceipt(p) ? 'receipt' : 'order',
      sentAt: String(p?.meta?.sentAtIso || new Date(r.createdAt).toISOString()),
      userId: Number(p?.meta?.userId) || null,
    });
  }
  return out;
}

/**
 * Print a stuck or failed kitchen slip again now, marked REPRINT. The job
 * leaves the retry queue either way, so it cannot print a second time on
 * its own when the printer comes back; a reprint that also fails goes
 * through the retry queue as a new job.
 */
export async function reprintStationPrintJob(
  id: number,
  actor: PrintJobActor,
): Promise<{ ok: boolean; error?: string }> {
  const row = (await prisma.printJob
    .findUnique({ where: { id: Number(id) } })
    .catch(logIgnored('printJobs:129', null))) as any;
  if (!row || !printJobIsWatched(row.payloadJson)) {
    return { ok: false, error: 'That print job no longer exists.' };
  }
  if (
    !reprintAllowed({
      actor,
      jobUserId: Number(row.payloadJson?.meta?.userId) || null,
      status: String(row.status),
    })
  ) {
    return {
      ok: false,
      error:
        String(row.status) === 'SENT'
          ? 'That slip already printed. Ask a manager to reprint it.'
          : 'Only the waiter who sent this order or a manager can reprint it.',
    };
  }
  const who = (await prisma.user
    .findUnique({ where: { id: Number(actor.userId) } })
    .catch(logIgnored('printJobs:150', null))) as any;
  const whoName = String(who?.displayName || `#${actor.userId}`);
  console.log(
    `[print] job #${row.id} reprinted by ${whoName} (user ${actor.userId})`,
  );
  const settings = await coreServices.readSettings();
  const p = row.payloadJson as any;
  const meta = { ...(p.meta || {}) };
  delete meta.lateSentAtIso;
  // A kitchen slip says it is a reprint and when it was first sent. A guest
  // receipt that never printed goes out once as the receipt (the guest has
  // none, QA round 6 #9); once one has printed (SENT, which a manager may
  // still reprint, and which a failed job becomes after this), every
  // reprint is marked KOPJE / COPY. It used to go out as a second original,
  // fiscal codes and all (QA v0.2.103, #5). `reprint` on a PAYMENT also
  // keeps it out of the sales ledger and fiskalizimi.
  const sentAt = meta.sentAtIso || new Date(row.createdAt).toISOString();
  if (!isGuestReceipt(p)) {
    meta.reprintOfIso = sentAt;
  } else if (String(row.status) === 'SENT') {
    meta.reprintOfIso = sentAt;
    meta.reprint = true;
  }
  await prisma.printJob
    .update({
      where: { id: row.id },
      data: {
        status: 'SENT' as any,
        lastError: `Reprinted by ${whoName}`,
        nextAttemptAt: null,
      } as any,
    })
    .catch(logIgnored('printJobs:182', undefined));
  meta.reprintedById = Number(actor.userId) || null;
  const r = await dispatchTicket({ ...p, meta }, settings as any, {
    persistRetryOnTransientFailure: true,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.firstError };
}
