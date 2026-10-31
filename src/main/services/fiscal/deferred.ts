/**
 * Transmit invoices that were taken while CIS/internet was down.
 *
 * Each deferred claim holds a frozen draft and the original docId. The loop
 * retries that exact body; it never rebuilds the invoice. After 48 hours
 * it keeps trying but escalates to admins (SelfCare / DPT is then on them).
 */

import type { SettingsDTO } from '@shared/ipc';
import { dueFiscalDeferAlert } from '@shared/fiscalDefer';
import { fiscalTinFromSettings, tinFromVerifyUrl } from '@shared/fiscalReceipt';
import { backoffDelayMs } from './backoff';
import {
  abandonUnsentFiscalClaimUnlocked,
  claimFiscalRegistration,
  commitDeferredFiscalClaim,
  commitRegisteredFiscalClaim,
  fiscalDeferredWorkMayExist,
  listFiscalClaimsDeferred,
  markFiscalDeferAlert,
  readFiscalClaim,
  settleFiscalClaimFailed,
  settleFiscalClaimUnknown,
  withFiscalClaimLock,
  FiscalClaimBusyError,
} from './claims';
import { sweepFiscalClaims } from './sitting';
import {
  createEasyPosSale,
  fiscalNeedsStatusCheck,
  fiscalOutcomeOf,
  isFiscalRetryable,
} from './easypos';
import { notifyAdminsAndActor } from '../adminAlerts';
import { prisma } from '@db/client';
import { filedLekTotal } from './mapInvoice';
import { ensureDailyBalanceForCash } from './balance';
import { fiscalConfig, latestFiscalSettings } from './config';
import type { FiscalDocInfo } from './completion';
import { isLeftoverTestWork, sameFiscalEnvironment } from './environment';

const LOOP_MS = 20_000;
const OUTAGE_NOTICE_MS = 30 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastOutageNoticeAt = 0;
let lastOtherServiceNoticeAt = 0;
const OTHER_SERVICE_NOTICE_MS = 6 * 60 * 60 * 1000;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function whereLabel(record: {
  context?: { area?: string; tableLabel?: string };
}): string {
  return [record.context?.area, record.context?.tableLabel]
    .filter(Boolean)
    .join(' ');
}

export async function stampFiscalIdentifiersOnSale(
  idempotencyKey: string,
  result: {
    nslf?: string;
    nivf?: string;
    eic?: string;
    link?: string;
    qrCode?: string;
    status?: string;
    doc?: FiscalDocInfo;
  },
): Promise<void> {
  const nslf = String(result.nslf || '').trim() || null;
  const nivf = String(result.nivf || '').trim() || null;
  const eic = String(result.eic || '').trim() || null;
  const link = String(result.link || '').trim();
  const qrCode = String(result.qrCode || '').trim();
  const { coreServices } = await import('../core');
  const settings = await coreServices.readSettings().catch(() => ({}));
  const tin =
    tinFromVerifyUrl(link) ||
    tinFromVerifyUrl(qrCode) ||
    fiscalTinFromSettings(settings);

  const job = await prisma.printJob
    .findUnique({ where: { idempotencyKey } })
    .catch(() => null);
  // `idempotencyKey` here is the sale's key (see the caller), which is the
  // claim key unless a correction restated the invoice under a new docId.
  if (job) {
    const payload = (job as any).payloadJson || {};
    const meta = { ...(payload.meta || {}) };
    if (nslf) meta.fiscalNslf = nslf;
    if (nivf) meta.fiscalNivf = nivf;
    if (eic) meta.fiscalEic = eic;
    if (link) meta.fiscalLink = link;
    if (qrCode) meta.fiscalQrCode = qrCode;
    if (tin) meta.fiscalTin = tin;
    if (result.doc) meta.fiscalDoc = result.doc;
    meta.fiscalStatus = result.status || 'accepted';
    delete meta.fiscalWarning;
    // Filed after the sale: the receipt keeps the sale's time (`paidAt`)
    // and says when the invoice was registered. easyPos takes no issue time
    // or subsequent-delivery field (unknown fields are refused with 400),
    // so the registration time is the tax service's own.
    meta.fiscalFiledLateAt = new Date().toISOString();
    if (meta.fiscalTotalLek == null) {
      const lek = filedLekTotal({ ...payload, meta } as any, settings as any);
      if (lek != null) meta.fiscalTotalLek = lek;
    }
    await prisma.printJob
      .update({
        where: { id: (job as any).id },
        data: { payloadJson: { ...payload, meta } } as any,
      })
      .catch(() => undefined);
  }

  // Cancellations and ticket history read Payment, not PrintJob. Leaving
  // these null after a deferred transmit made later voids look unfiscalized.
  const payment = await prisma.payment
    .findUnique({ where: { idempotencyKey } })
    .catch(() => null);
  if (!payment) return;
  const metaJson = {
    ...(((payment as any).metaJson as Record<string, unknown>) || {}),
  };
  if (nslf) metaJson.fiscalNslf = nslf;
  if (nivf) metaJson.fiscalNivf = nivf;
  if (eic) metaJson.fiscalEic = eic;
  if (link) metaJson.fiscalLink = link;
  if (qrCode) metaJson.fiscalQrCode = qrCode;
  if (tin) metaJson.fiscalTin = tin;
  if (result.doc) metaJson.fiscalDoc = result.doc;
  metaJson.fiscalStatus = result.status || 'accepted';
  delete metaJson.fiscalWarning;
  await prisma.payment
    .update({
      where: { id: (payment as any).id },
      data: {
        ...(nslf ? { fiscalNslf: nslf } : {}),
        ...(nivf ? { fiscalNivf: nivf } : {}),
        ...(eic ? { fiscalEic: eic } : {}),
        metaJson,
      } as any,
    })
    .catch(() => undefined);
}

/**
 * A cash invoice sent after midnight needs that day's opening float, and the
 * float is otherwise declared only when a waiter takes a cash payment. An
 * outage that ran overnight therefore sent yesterday's cash invoices before
 * anything declared today's float; the tax service refused them as
 * "daily balance not reported", which is permanent, and every one of them
 * had to be filed by hand in SelfCare.
 */
async function declareFloatForCashDraft(
  settings: SettingsDTO,
  draft: unknown,
): Promise<void> {
  try {
    if (!fiscalConfig(settings).cloud) return;
    const raw = (draft as any)?.payment;
    const payments = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const cash = payments.some(
      (p: any) => String(p?.type || '').toUpperCase() === 'CASH',
    );
    if (!cash) return;
    const configured = Number((settings as any)?.fiscal?.openingFloat);
    await ensureDailyBalanceForCash(settings, {
      openingFloat:
        Number.isFinite(configured) && configured >= 0 ? configured : 0,
    });
  } catch (e: any) {
    // The register call is the authority; it reports a missing float itself.
    console.warn(
      `[fiscal-defer] could not check today's opening float: ${String(e?.message || e)}`,
    );
  }
}

async function noticeOutage(message: string): Promise<void> {
  const now = Date.now();
  if (now - lastOutageNoticeAt < OUTAGE_NOTICE_MS) return;
  lastOutageNoticeAt = now;
  console.warn(`[fiscal-defer] unreachable: ${message}`);
  await notifyAdminsAndActor({
    message:
      'Fiskalizimi is unreachable. Sales continue and will be sent automatically (48-hour window).',
    type: 'SECURITY',
  }).catch(() => undefined);
}

async function noticeDeadline(
  idempotencyKey: string,
  record: {
    createdAt: string;
    lastAlertKey?: string;
    context?: { area?: string; tableLabel?: string; total?: number };
  },
  now: number,
): Promise<void> {
  const due = dueFiscalDeferAlert(record.createdAt, record.lastAlertKey, now);
  if (!due) return;
  const where = whereLabel(record);
  const overdue = due === 'overdue';
  await notifyAdminsAndActor({
    message: overdue
      ? `Fiskalizimi 48-hour window missed${where ? ` on ${where}` : ''} · docId ${idempotencyKey}. Transmit via SelfCare if automatic retry keeps failing, and notify DPT if the outage itself lasted more than 48 hours.`
      : `Fiskalizimi still pending (${due})${where ? ` on ${where}` : ''} · docId ${idempotencyKey}. The invoice must reach CIS within 48 hours of the sale.`,
    type: 'SECURITY',
  }).catch(() => undefined);
  await markFiscalDeferAlert(idempotencyKey, due).catch(() => undefined);
}

export async function transmitDueDeferredInvoices(
  settings: SettingsDTO,
  options?: { now?: number },
): Promise<{ attempted: number; registered: number }> {
  if ((settings as any)?.fiscal?.enabled !== true) {
    return { attempted: 0, registered: 0 };
  }
  const now = options?.now ?? Date.now();
  if (!fiscalDeferredWorkMayExist()) return { attempted: 0, registered: 0 };
  // Oldest sale first, so invoices reach CIS in the order they were made.
  const rows = (await listFiscalClaimsDeferred()).sort(
    (a, b) =>
      (Date.parse(a.record.createdAt) || 0) -
      (Date.parse(b.record.createdAt) || 0),
  );
  let attempted = 0;
  let registered = 0;
  // Once one send finds easyPos unreachable the rest would too, each after
  // its own full recovery budget (~90s) — hours for a long outage queue,
  // during which nothing else in this loop runs.
  let unreachable = false;
  const environment = fiscalConfig(settings).environment;
  let droppedTest = 0;
  let waitingElsewhere = 0;

  for (const { idempotencyKey, record } of rows) {
    const madeOn = record.context?.environment;
    if (isLeftoverTestWork(madeOn, environment)) {
      // A test-service sale: it must never reach the tax authority.
      const dropped = await withFiscalClaimLock(
        idempotencyKey,
        () =>
          abandonUnsentFiscalClaimUnlocked(
            idempotencyKey,
            'Made on the easyPos test service; not sent to the live service.',
            { statusConfirmedAbsent: true },
          ),
        1_000,
      ).catch(() => false);
      if (dropped) droppedTest += 1;
      continue;
    }
    if (!sameFiscalEnvironment(madeOn, environment)) {
      waitingElsewhere += 1;
      continue;
    }
    await noticeDeadline(idempotencyKey, record, now);
    const dueAt = Date.parse(record.nextAttemptAt || '') || 0;
    if (dueAt > now || unreachable) continue;

    attempted += 1;
    const draft = record.draft;
    if (!draft) {
      await noticeOutage(
        `docId ${idempotencyKey} has no stored invoice body — cannot retry automatically.`,
      );
      continue;
    }

    // One claim at a time, under the lock a reversal also takes: a sale
    // cancelled while it waits here is seen as ABANDONED below and never
    // sent, and one cancelled while it is being sent waits for the outcome.
    // With the settings as they are now: a URL changed during this pass
    // applies to the next invoice, not the next pass.
    const latest = await latestFiscalSettings(settings);
    if ((latest as any)?.fiscal?.enabled !== true) break;
    if (!sameFiscalEnvironment(madeOn, fiscalConfig(latest).environment)) {
      waitingElsewhere += 1;
      continue;
    }
    try {
      const sent = await withFiscalClaimLock(
        idempotencyKey,
        () => transmitOne(latest, idempotencyKey, record, draft, now),
        1_000,
      );
      if (sent === 'sent') registered += 1;
      if (sent === 'unreachable') unreachable = true;
    } catch (e) {
      if (e instanceof FiscalClaimBusyError) continue;
      console.warn(`[fiscal-defer] docId ${idempotencyKey} failed:`, e);
    }
  }

  if (droppedTest > 0) {
    await notifyAdminsAndActor({
      message: `Fiskalizimi: ${droppedTest} invoice(s) queued while the till used the easyPos test service were not sent to the live service.`,
      type: 'SECURITY',
    }).catch(() => undefined);
  }
  if (
    waitingElsewhere > 0 &&
    now - lastOtherServiceNoticeAt >= OTHER_SERVICE_NOTICE_MS
  ) {
    lastOtherServiceNoticeAt = now;
    await notifyAdminsAndActor({
      message: `Fiskalizimi: ${waitingElsewhere} invoice(s) were taken on the live easyPos service and are still waiting to be sent. They are not sent to the test service the till now points at — switch Settings › Fiskalizimi back to the live service so they reach the tax authority within 48 hours.`,
      type: 'SECURITY',
    }).catch(() => undefined);
  }

  return { attempted, registered };
}

async function transmitOne(
  settings: SettingsDTO,
  idempotencyKey: string,
  record: Awaited<
    ReturnType<typeof listFiscalClaimsDeferred>
  >[number]['record'],
  draft: unknown,
  now: number,
): Promise<'sent' | 'unreachable' | 'not-sent'> {
  const current = await readFiscalClaim(idempotencyKey);
  if (!current || current.state !== 'DEFERRED') return 'not-sent';

  let decision: Awaited<ReturnType<typeof claimFiscalRegistration>>;
  try {
    decision = await claimFiscalRegistration(idempotencyKey, record.context);
  } catch {
    return 'not-sent';
  }
  if (decision.outcome !== 'proceed') return 'not-sent';

  const latest = await readFiscalClaim(idempotencyKey);
  if (!latest || latest.state === 'ABANDONED') return 'not-sent';
  const saleKey =
    String(latest.context?.saleKey || '').trim() || idempotencyKey;

  await declareFloatForCashDraft(settings, draft);

  try {
    const result = latest.checkStatusFirst
      ? await createEasyPosSale(settings, draft as any, { statusFirst: true })
      : await createEasyPosSale(settings, draft as any);
    const storedResult = {
      nslf: result.nslf || undefined,
      nivf: result.nivf || undefined,
      eic: result.eic || undefined,
      link: result.link || undefined,
      qrCode: result.qrCode || undefined,
      ...(result.doc ? { doc: result.doc } : {}),
      status: result.status,
    };
    const stored = await commitRegisteredFiscalClaim(
      idempotencyKey,
      decision.attemptId,
      storedResult,
    );
    // The sale already exists. Stamp the codes even when the claim could
    // only be parked, so a later void still sees the NIVF.
    await stampFiscalIdentifiersOnSale(saleKey, result).catch(() => undefined);
    if (!stored.ok) {
      await notifyAdminsAndActor({
        message:
          stored.message ||
          `Fiskalizimi accepted docId ${idempotencyKey} but the local record could not be saved.`,
        type: 'SECURITY',
      }).catch(() => undefined);
      return 'not-sent';
    }
    // The guest left with the pending receipt: say the fiscal one is ready.
    const { noticeLateFiscalReceipt } = await import('../fiscalReceiptReprint');
    await noticeLateFiscalReceipt({
      saleKey,
      nivf: result.nivf || undefined,
    }).catch(() => undefined);
    return 'sent';
  } catch (e: any) {
    const message = String(e?.message || e);
    if (fiscalOutcomeOf(e) === 'not-registered' && isFiscalRetryable(e)) {
      const nextAttemptAt = new Date(
        now + backoffDelayMs(Math.max(1, (latest.attempts || 1) + 1)),
      ).toISOString();
      const queued = await commitDeferredFiscalClaim(
        idempotencyKey,
        decision.attemptId,
        message,
        cloneJson(draft),
        nextAttemptAt,
        { checkStatusFirst: fiscalNeedsStatusCheck(e) },
      );
      if (!queued) {
        console.warn(
          `[fiscal-defer] docId ${idempotencyKey} could not be re-queued: ${message}`,
        );
      }
      await noticeOutage(message);
      return 'unreachable';
    }
    if (fiscalOutcomeOf(e) === 'not-registered') {
      await settleFiscalClaimFailed(
        idempotencyKey,
        decision.attemptId,
        message,
      ).catch(() => undefined);
      await notifyAdminsAndActor({
        message: `Deferred fiskalizimi is now refused${whereLabel(latest) ? ` on ${whereLabel(latest)}` : ''} · docId ${idempotencyKey}: ${message}`,
        type: 'SECURITY',
      }).catch(() => undefined);
      return 'not-sent';
    }
    await settleFiscalClaimUnknown(
      idempotencyKey,
      decision.attemptId,
      message,
    ).catch(() => undefined);
    return 'not-sent';
  }
}

export function startFiscalDeferLoop(): void {
  if (timer) return;
  let firstRun = true;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      // Interrupted sends and invoices with no saved sale still need a
      // human after fiscalization is switched off, so this runs regardless.
      await sweepFiscalClaims({ force: firstRun }).catch((e) =>
        console.warn('[fiscal-sweep] failed:', e),
      );
      firstRun = false;
      const { coreServices } = await import('../core');
      const settings = (await coreServices
        .readSettings()
        .catch(() => null)) as SettingsDTO | null;
      if (!settings || (settings as any)?.fiscal?.enabled !== true) return;
      await transmitDueDeferredInvoices(settings);
      // Cancellations / correctives that hit an outage. Imported lazily:
      // saleCorrection depends on this module's neighbours.
      const { retryQueuedFiscalCorrections } = await import(
        '../saleCorrection'
      );
      await retryQueuedFiscalCorrections(settings).catch((e) =>
        console.warn('[fiscal-defer] correction retry failed:', e),
      );
    } catch (e) {
      console.warn('[fiscal-defer] tick failed:', e);
    } finally {
      running = false;
    }
  };
  void runOnce();
  timer = setInterval(() => void runOnce(), LOOP_MS);
}

export function stopFiscalDeferLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
