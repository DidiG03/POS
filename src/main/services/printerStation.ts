import { BrowserWindow } from 'electron';

import { prisma } from '@db/client';

import { coreServices } from './core';
import {
  RETRY_MAX_ATTEMPTS,
  dispatchTicket,
  enqueuePrintRetry,
  isTransientPrintError,
  loadDuePrintRetries,
  nextPendingRetryAt,
  pickPrinterProfile,
  printWithProfile,
  setRetryWakeup,
} from './printDispatcher';

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

function broadcast(channel: string, payload: any) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch {
    // ignore — no UIs open is fine
  }
}

async function processRetryRow(
  row: any,
  settings: any,
): Promise<{ recovered: boolean; permanentlyFailed: boolean }> {
  const payload = (row?.payloadJson as any) || {};
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
    return { recovered: true, permanentlyFailed: false };
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
        } as any,
      })
      .catch(() => {});
    return { recovered: false, permanentlyFailed: true };
  }

  // Still a network blip — re-enqueue (creates a NEW row with the next
  // backoff slot). Mark the current row as superseded so we don't
  // pick it up again.
  await prisma.printJob
    .update({
      where: { id: row.id },
      data: {
        status: 'FAILED' as any,
        attempts: nextAttempts,
        lastError: r.error || 'transient print failure',
      } as any,
    })
    .catch(() => {});
  const result = await enqueuePrintRetry({
    payload,
    printerProfileId: profile.id,
    error: r.error || 'transient print failure',
    priorAttempts: nextAttempts,
  });
  return {
    recovered: false,
    permanentlyFailed: result.status === 'FAILED',
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

    for (const row of dueRetries) {
      try {
        const r = await processRetryRow(row, settings);
        if (r.recovered) recoveries++;
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
      // Tell every renderer "the printer's back". Useful for clearing a
      // stuck error toast or showing a green "X of Y prints recovered"
      // confirmation.
      broadcast('printer:event', {
        level: 'info',
        kind: 'recovered',
        message:
          recoveries === 1
            ? 'A queued print succeeded after retry.'
            : `${recoveries} queued prints succeeded after retry.`,
        at: Date.now(),
        context: { recoveries },
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
async function schedule(): Promise<void> {
  if (stopping) return;
  let delay = IDLE_INTERVAL_MS;
  try {
    const next = await nextPendingRetryAt();
    if (next) {
      const ms = Math.max(250, next.getTime() - Date.now());
      delay = Math.min(delay, ms);
    }
  } catch {
    delay = IDLE_INTERVAL_MS;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void (async () => {
      try {
        await tick();
      } finally {
        void schedule();
      }
    })();
  }, delay);
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
    timer = setTimeout(() => {
      void (async () => {
        try {
          await tick();
        } finally {
          void schedule();
        }
      })();
    }, wait);
  });

  // First tick + scheduling kick-off.
  void (async () => {
    try {
      await tick();
    } finally {
      void schedule();
    }
  })();
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
