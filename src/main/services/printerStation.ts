import { prisma } from '@db/client';

import { coreServices } from './core';
import {
  RETRY_MAX_ATTEMPTS,
  dispatchTicket,
  isStationSlip,
  isTransientPrintError,
  loadDuePrintRetries,
  markPrinterResult,
  nextPendingRetryAt,
  pickPrinterProfile,
  printRetryPlan,
  printWithProfile,
  setRetryWakeup,
} from './printDispatcher';
import { notifyStationPrintFailed } from './printJobNotify';
import { broadcastPrinterEvent } from './realtime';

/** A kitchen slip printed this long after it was sent says so on top. */
export const LATE_SLIP_AFTER_MS = 60_000;

/**
 * Background job processor for the local PrintJob table. Two distinct
 * responsibilities live in here, intentionally combined so we only run
 * one timer:
 *
 *   1. RETRY rows (PR 3) — prints that failed transiently and were
 *      persisted for an automatic retry. Runs on every install.
 *
 * Cadence is adaptive (PR 3): we sleep until the next RETRY row's
 * `nextAttemptAt`, or until 5 minutes of nothing-to-do otherwise. `setRetryWakeup`
 * lets `enqueuePrintRetry` interrupt our sleep early so a fresh retry
 * doesn't have to wait out a long idle nap. This is dramatically
 * cheaper than the old fixed 2.5 s setInterval (which was firing
 * ~34 000 empty SQLite queries/day on local installs) without
 * sacrificing responsiveness.
 */

let started = false;
let timer: NodeJS.Timeout | null = null;
let running = false;
let stopping = false;

/** Maximum nap when nothing is pending. */
const IDLE_INTERVAL_MS = 5 * 60_000;

/**
 * Pause before the next pass when rows are due but the last pass could not
 * act on any (only parked rows left), so the loop does not spin.
 */
const DUE_BUT_IDLE_DELAY_MS = 5_000;

/** How long rows wait when their printer just timed out in this pass. */
const DOWN_PRINTER_DEFER_MS = 5_000;

/**
 * Rows whose chit reached the printer but whose status could not be written
 * back. They must never be attempted again, even though the database still
 * says they are due.
 */
const sentButUnrecorded = new Set<number>();

/** Record a successful print, retrying once in case the database was busy. */
async function markPrintJobSent(id: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prisma.printJob.update({
        where: { id },
        data: { status: 'SENT' as any, lastError: null } as any,
      });
      sentButUnrecorded.delete(Number(id));
      return true;
    } catch {
      // SQLite returns SQLITE_BUSY under concurrent writes; a short pause is
      // usually all it takes.
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return false;
}

async function processRetryRow(
  row: any,
  settings: any,
): Promise<{
  recovered: boolean;
  permanentlyFailed: boolean;
  /** The printer itself looks unreachable (timeout, refused). */
  printerDown?: boolean;
  /** Printed, but later than {@link LATE_SLIP_AFTER_MS} after its Send. */
  late?: boolean;
}> {
  const stored = (row?.payloadJson as any) || {};
  const station = isStationSlip(stored);
  const sentAtIso = String(
    stored?.meta?.sentAtIso ||
      new Date(row?.createdAt || Date.now()).toISOString(),
  );
  // A slip the kitchen gets minutes late must not read like a new order.
  const late =
    station &&
    !stored?.meta?.reprintOfIso &&
    Date.now() - new Date(sentAtIso).getTime() > LATE_SLIP_AFTER_MS;
  const payload = late
    ? { ...stored, meta: { ...(stored.meta || {}), lateSentAtIso: sentAtIso } }
    : stored;
  const profileId = String(row?.printerProfileId || '');
  const profile = pickPrinterProfile(settings, profileId);
  // The destination profile may have been deleted from settings while
  // a retry was queued — in that case there's nothing to retry against.
  // Mark it FAILED with a clear reason instead of looping forever.
  if (!profile) {
    await prisma.printJob
      .update({
        where: { id: row.id },
        data: {
          status: 'FAILED' as any,
          lastError: `Printer profile "${profileId}" no longer exists`,
        } as any,
      })
      .catch(() => {});
    return { recovered: false, permanentlyFailed: true };
  }

  // No in-flight retries here: `printWithProfile` already does a fast
  // 250 ms one. The persistent retry queue's whole point is the LONGER
  // backoff, so each loop tick performs exactly one network attempt.
  console.log(
    `[PrinterRetry] Attempting row #${row.id} (printer=${profileId}, attempt=${row.attempts}/${RETRY_MAX_ATTEMPTS})`,
  );
  const r = await printWithProfile(payload, settings as any, profile, {
    retries: 0,
  });
  // Keeps the payments' "printer down" mark in step: a success here is
  // usually the first sign the printer is back.
  markPrinterResult(profile.id, r.ok, r.error);
  if (r.ok) {
    // The paper is already out of the printer. If we cannot record that, the
    // row stays due and the next tick prints the same chit again — the kitchen
    // ends up cooking a duplicate order. Retry the write, and if the database
    // is still unavailable park the row so the loop cannot pick it up.
    const recorded = await markPrintJobSent(row.id);
    if (!recorded) {
      console.error(
        `[PrinterRetry] Row #${row.id} printed but could not be marked SENT; ` +
          'parking it so the ticket is not printed twice.',
      );
      sentButUnrecorded.add(Number(row.id));
    }
    console.log(
      `[PrinterRetry] ✓ Row #${row.id} succeeded after ${row.attempts} attempt(s)`,
    );
    return { recovered: true, permanentlyFailed: false, late };
  }
  console.log(
    `[PrinterRetry] ✗ Row #${row.id} attempt failed: ${r.error || '(no error)'}`,
  );

  const nextAttempts = Number(row?.attempts || 1) + 1;
  // Out-of-paper / authentication / unknown printer = permanent.
  // Don't waste 4 minutes retrying something that's not coming back.
  if (!isTransientPrintError(r.error)) {
    await prisma.printJob
      .update({
        where: { id: row.id },
        data: {
          status: 'FAILED' as any,
          attempts: nextAttempts,
          lastError: r.error || 'print failed',
          nextAttemptAt: null,
        } as any,
      })
      .catch(() => {});
    if (station) {
      await notifyStationPrintFailed({
        payload: stored,
        printerName: profile.name,
        error: r.error,
      });
    }
    return { recovered: false, permanentlyFailed: true };
  }

  // Still a network blip: try again later on this same row, so a job is
  // one print-log line with its attempt count, not a FAILED row per try.
  const plan = printRetryPlan({
    attempts: nextAttempts,
    station,
    firstFailedAt: new Date(row?.createdAt || Date.now()).getTime(),
  });
  const error = r.error || 'transient print failure';
  await prisma.printJob
    .update({
      where: { id: row.id },
      data:
        plan.status === 'RETRY'
          ? {
              status: 'RETRY' as any,
              attempts: nextAttempts,
              lastError: error,
              nextAttemptAt: new Date(Date.now() + plan.delayMs),
            }
          : {
              status: 'FAILED' as any,
              attempts: nextAttempts,
              lastError: error,
              nextAttemptAt: null,
            },
    } as any)
    .catch(() => {});
  if (plan.status === 'FAILED' && station) {
    await notifyStationPrintFailed({
      payload: stored,
      printerName: profile.name,
      error,
    });
  }
  return {
    recovered: false,
    permanentlyFailed: plan.status === 'FAILED',
    printerDown: true,
  };
}

async function processQueuedRow(row: any, settings: any): Promise<void> {
  const payload = (row?.payloadJson as any) || {};
  const r = await dispatchTicket(payload, settings as any, {
    persistRetryOnTransientFailure: true,
  });
  if (r.ok) {
    // Same rule as the retry path: a chit that printed must never be picked up
    // again just because we could not write down that it printed.
    if (!(await markPrintJobSent(row.id))) {
      sentButUnrecorded.add(Number(row.id));
    }
    return;
  }
  await prisma.printJob
    .update({
      where: { id: row.id },
      data: { status: 'FAILED' as any } as any,
    })
    .catch(() => {});
}

async function tick(): Promise<{ idle: boolean }> {
  if (running) return { idle: true };
  running = true;
  try {
    // Clear any backlog parked by a failed status write now that we get
    // another chance at the database.
    for (const id of [...sentButUnrecorded]) await markPrintJobSent(id);

    const dueRetries = (await loadDuePrintRetries(20)).filter(
      (row: any) => !sentButUnrecorded.has(Number(row?.id)),
    );
    const queuedJobs = (
      await prisma.printJob
        .findMany({
          where: { status: 'QUEUED' as any },
          orderBy: { createdAt: 'asc' },
          take: 20,
        })
        .catch(() => [])
    ).filter((row: any) => !sentButUnrecorded.has(Number(row?.id)));

    if (!dueRetries.length && !queuedJobs.length) return { idle: true };

    const settings = await coreServices.readSettings();
    let recoveries = 0;
    let lateSlips = 0;

    // One unreachable printer used to cost a connect timeout per due row,
    // so after an outage the loop spent minutes timing out and receipts
    // printed long after the printer was back. After the first timeout,
    // that printer's other rows wait for the next pass without using up
    // an attempt.
    const downThisTick = new Set<string>();
    for (const row of dueRetries) {
      const profileId = String(row?.printerProfileId || '');
      if (downThisTick.has(profileId)) {
        await prisma.printJob
          .update({
            where: { id: row.id },
            data: {
              nextAttemptAt: new Date(Date.now() + DOWN_PRINTER_DEFER_MS),
            } as any,
          })
          .catch(() => {});
        continue;
      }
      try {
        const r = await processRetryRow(row, settings);
        if (r.recovered) recoveries++;
        if (r.recovered && r.late) lateSlips++;
        if (r.printerDown) downThisTick.add(profileId);
      } catch {
        // Row-level failure shouldn't break the whole loop; the next
        // tick will pick the row up again because we leave its status
        // as RETRY in this branch.
      }
    }

    for (const row of queuedJobs) {
      try {
        await processQueuedRow(row, settings);
      } catch {
        // ignore — same reasoning as above
      }
    }

    if (recoveries > 0) {
      // Tell every till window and phone "the printer's back", so the
      // offline warning they showed is answered.
      broadcastPrinterEvent({
        level: 'info',
        kind: 'recovered',
        message:
          (recoveries === 1
            ? 'A queued print went through.'
            : `${recoveries} queued prints went through.`) +
          (lateSlips > 0
            ? ` ${lateSlips === 1 ? 'One kitchen slip is' : `${lateSlips} kitchen slips are`} marked LATE COPY.`
            : ''),
        at: Date.now(),
        context: { recoveries, lateSlips },
      });
    }
    return { idle: false };
  } finally {
    running = false;
  }
}

/**
 * Schedule the next tick. Strategy:
 *   - If a RETRY row is due NOW, run almost immediately (250 ms).
 *   - Else if a RETRY row is pending in the future, sleep until then.
 *   - Else nap for IDLE_INTERVAL_MS (cheap heartbeat in case the
 *     wake-up callback was missed during a Prisma reconnect).
 */
async function schedule(lastPassIdle = false): Promise<void> {
  if (stopping) return;
  let delay = IDLE_INTERVAL_MS;
  try {
    const next = await nextPendingRetryAt();
    if (next) {
      const floor = lastPassIdle ? DUE_BUT_IDLE_DELAY_MS : 250;
      const ms = Math.max(floor, next.getTime() - Date.now());
      delay = Math.min(delay, ms);
    }
  } catch {
    delay = IDLE_INTERVAL_MS;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(runPass, delay);
}

/** One pass, then schedule the next. */
function runPass(): void {
  void (async () => {
    let idle = false;
    try {
      idle = (await tick()).idle;
    } finally {
      void schedule(idle);
    }
  })();
}

export async function startPrinterStationLoop(): Promise<void> {
  if (started) return;
  started = true;
  stopping = false;

  console.log('[PrinterStation] Loop started (retryQueue=enabled)');

  // When `enqueuePrintRetry` persists a new row, wake up early so we
  // don't sleep through it.
  setRetryWakeup((dueAtMs) => {
    if (stopping) return;
    const wait = Math.max(50, dueAtMs - Date.now());
    if (timer) clearTimeout(timer);
    timer = setTimeout(runPass, wait);
  });

  // First tick + scheduling kick-off.
  runPass();
}

export function stopPrinterStationLoop(): void {
  stopping = true;
  sentButUnrecorded.clear();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  setRetryWakeup(null);
  started = false;
}

/** Allow callers to check exhaustion bound — used by tests + future UI. */
export const PRINT_RETRY_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS;

/** Tests only: one pass of the loop. */
export const runPrinterStationTickForTests = tick;
