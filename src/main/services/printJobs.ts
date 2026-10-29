/**
 * Kitchen slips that have not printed, for staff to see and reprint.
 *
 * A slip stuck in the retry queue, or given up on, was only visible in the
 * database. Staff now see them under Printer jobs (notifications panel) and
 * can print one again, marked REPRINT with the time it was first sent.
 */
import { prisma } from '@db/client';
import { coreServices } from './core';
import {
  dispatchTicket,
  isStationSlip,
  pickPrinterProfile,
} from './printDispatcher';

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
    .catch(() => [])) as any[];
  const settings = await coreServices.readSettings().catch(() => ({}));
  const out: StationPrintJobDTO[] = [];
  for (const r of rows) {
    const p = (r.payloadJson || {}) as any;
    if (!isStationSlip(p)) continue;
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
    .catch(() => null)) as any;
  if (!row || !isStationSlip(row.payloadJson)) {
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
    .catch(() => null)) as any;
  const whoName = String(who?.displayName || `#${actor.userId}`);
  console.log(
    `[print] job #${row.id} reprinted by ${whoName} (user ${actor.userId})`,
  );
  const settings = await coreServices.readSettings();
  const p = row.payloadJson as any;
  const meta = { ...(p.meta || {}) };
  delete meta.lateSentAtIso;
  meta.reprintOfIso = meta.sentAtIso || new Date(row.createdAt).toISOString();
  await prisma.printJob
    .update({
      where: { id: row.id },
      data: {
        status: 'SENT' as any,
        lastError: `Reprinted by ${whoName}`,
        nextAttemptAt: null,
      } as any,
    })
    .catch(() => {});
  meta.reprintedById = Number(actor.userId) || null;
  const r = await dispatchTicket({ ...p, meta }, settings as any, {
    persistRetryOnTransientFailure: true,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.firstError };
}
