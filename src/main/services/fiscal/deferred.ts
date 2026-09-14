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
  claimFiscalRegistration,
  listFiscalClaimsDeferred,
  markFiscalDeferAlert,
  readFiscalClaim,
  settleFiscalClaimDeferred,
  settleFiscalClaimFailed,
  settleFiscalClaimRegistered,
  settleFiscalClaimUnknown,
} from './claims';
import {
  createEasyPosSale,
  fiscalOutcomeOf,
  isFiscalRetryable,
} from './easypos';
import { notifyAdminsAndActor } from '../adminAlerts';
import { prisma } from '@db/client';

const LOOP_MS = 20_000;
const OUTAGE_NOTICE_MS = 30 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastOutageNoticeAt = 0;

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

async function stampFiscalIdentifiersOnSale(
  idempotencyKey: string,
  result: {
    nslf?: string;
    nivf?: string;
    eic?: string;
    link?: string;
    qrCode?: string;
    status?: string;
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
  if (job) {
    const payload = (job as any).payloadJson || {};
    const meta = { ...(payload.meta || {}) };
    if (nslf) meta.fiscalNslf = nslf;
    if (nivf) meta.fiscalNivf = nivf;
    if (eic) meta.fiscalEic = eic;
    if (link) meta.fiscalLink = link;
    if (qrCode) meta.fiscalQrCode = qrCode;
    if (tin) meta.fiscalTin = tin;
    meta.fiscalStatus = result.status || 'accepted';
    delete meta.fiscalWarning;
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
  const rows = await listFiscalClaimsDeferred();
  let attempted = 0;
  let registered = 0;

  for (const { idempotencyKey, record } of rows) {
    await noticeDeadline(idempotencyKey, record, now);
    const dueAt = Date.parse(record.nextAttemptAt || '') || 0;
    if (dueAt > now) continue;

    attempted += 1;
    const draft = record.draft;
    if (!draft) {
      await noticeOutage(
        `docId ${idempotencyKey} has no stored invoice body — cannot retry automatically.`,
      );
      continue;
    }

    let decision: Awaited<ReturnType<typeof claimFiscalRegistration>>;
    try {
      decision = await claimFiscalRegistration(idempotencyKey, record.context);
    } catch {
      continue;
    }
    if (decision.outcome !== 'proceed') continue;

    const latest = await readFiscalClaim(idempotencyKey);
    if (!latest || latest.state === 'ABANDONED') continue;

    try {
      const result = await createEasyPosSale(settings, draft as any);
      await settleFiscalClaimRegistered(idempotencyKey, decision.attemptId, {
        nslf: result.nslf || undefined,
        nivf: result.nivf || undefined,
        eic: result.eic || undefined,
        link: result.link || undefined,
        qrCode: result.qrCode || undefined,
        status: result.status,
      }).catch(() => undefined);
      await stampFiscalIdentifiersOnSale(idempotencyKey, result).catch(
        () => undefined,
      );
      registered += 1;
    } catch (e: any) {
      const message = String(e?.message || e);
      if (fiscalOutcomeOf(e) === 'not-registered' && isFiscalRetryable(e)) {
        const nextAttemptAt = new Date(
          now + backoffDelayMs(Math.max(1, (latest.attempts || 1) + 1)),
        ).toISOString();
        await settleFiscalClaimDeferred(
          idempotencyKey,
          decision.attemptId,
          message,
          cloneJson(draft),
          nextAttemptAt,
        ).catch(() => undefined);
        await noticeOutage(message);
        continue;
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
        continue;
      }
      await settleFiscalClaimUnknown(
        idempotencyKey,
        decision.attemptId,
        message,
      ).catch(() => undefined);
    }
  }

  return { attempted, registered };
}

export function startFiscalDeferLoop(): void {
  if (timer) return;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const { coreServices } = await import('../core');
      const settings = (await coreServices
        .readSettings()
        .catch(() => null)) as SettingsDTO | null;
      if (!settings || (settings as any)?.fiscal?.enabled !== true) return;
      await transmitDueDeferredInvoices(settings);
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
