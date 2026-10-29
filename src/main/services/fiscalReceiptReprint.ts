/**
 * The fiscal receipt of a sale whose invoice was filed after the guest had
 * left (an outage, a queued payment).
 *
 * The guest got the "fiskalizimi pending" receipt; when the queue filed the
 * invoice later, nothing printed or offered the receipt with its NIVF and
 * QR. The deferred send already writes the codes onto the sale's receipt
 * (`stampFiscalIdentifiersOnSale`), so this prints that receipt again,
 * marked as a reprint, from Admin › the sale, and the waiter is told when
 * it is ready (`noticeLateFiscalReceipt`).
 */
import { prisma } from '@db/client';
import { coreServices } from './core';
import { notifyAdminsAndActor } from './adminAlerts';

export type FiscalReceiptReprintResult =
  | { ok: true; printed: boolean }
  | { ok: false; error: 'not-found' | 'not-fiscalized' | 'no-receipt' };

function text(v: unknown): string {
  return String(v ?? '').trim();
}

export async function printFiscalReceiptForSale(
  orderId: number,
): Promise<FiscalReceiptReprintResult> {
  const order: any = await prisma.order
    .findUnique({
      where: { id: Number(orderId) },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    } as any)
    .catch(() => null);
  if (!order) return { ok: false, error: 'not-found' };
  const payment = Array.isArray(order.payments) ? order.payments[0] : null;
  const key = text(payment?.idempotencyKey);
  if (!key) return { ok: false, error: 'no-receipt' };
  const job: any = await prisma.printJob
    .findUnique({ where: { idempotencyKey: key } } as any)
    .catch(() => null);
  const payload = job?.payloadJson;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'no-receipt' };
  }
  const paymentMeta =
    payment?.metaJson && typeof payment.metaJson === 'object'
      ? payment.metaJson
      : {};
  const meta: Record<string, unknown> = { ...(payload.meta || {}) };
  // The payment row is stamped too; fill anything the receipt lacks.
  const fill = (k: string, v: unknown) => {
    if (!text(meta[k]) && text(v)) meta[k] = text(v);
  };
  fill('fiscalNivf', payment?.fiscalNivf);
  fill('fiscalNslf', payment?.fiscalNslf);
  fill('fiscalEic', payment?.fiscalEic);
  fill('fiscalLink', paymentMeta.fiscalLink);
  fill('fiscalQrCode', paymentMeta.fiscalQrCode);
  fill('fiscalTin', paymentMeta.fiscalTin);
  if (!text(meta.fiscalNivf)) return { ok: false, error: 'not-fiscalized' };
  meta.fiscalEnabled = true;
  meta.fiscalStatus = 'accepted';
  delete meta.fiscalWarning;
  // A reprint: never a sale, never fiscalized again.
  meta.reprint = true;
  const settings: any = await coreServices.readSettings();
  const { dispatchTicket } = await import('./printDispatcher');
  const result = await dispatchTicket({ ...payload, meta } as any, settings, {
    persistRetryOnTransientFailure: false,
  }).catch(() => ({ ok: false }) as { ok: boolean });
  return { ok: true, printed: Boolean(result?.ok) };
}

/**
 * Tell the waiter (and admins) that a queued invoice was filed and its
 * fiscal receipt can be printed from the sale.
 */
export async function noticeLateFiscalReceipt(input: {
  saleKey: string;
  nivf?: string;
}): Promise<void> {
  const job: any = await prisma.printJob
    .findUnique({ where: { idempotencyKey: input.saleKey } } as any)
    .catch(() => null);
  const meta = job?.payloadJson?.meta || {};
  const where = [job?.payloadJson?.area, job?.payloadJson?.tableLabel]
    .map(text)
    .filter(Boolean)
    .join(' ');
  await notifyAdminsAndActor({
    message:
      `Fiskalizimi: the invoice${where ? ` for ${where}` : ''} was filed after the sale` +
      `${input.nivf ? ` (NIVF ${input.nivf})` : ''}. Its fiscal receipt with the QR can be printed from the sale in Admin › Tickets.`,
    actorUserId: Number(meta.userId || 0) || undefined,
    type: 'OTHER',
  }).catch(() => undefined);
}
