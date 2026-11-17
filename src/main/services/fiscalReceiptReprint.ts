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
import { storedReceiptForSale } from './receiptReprint';
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
  const stored = await storedReceiptForSale(orderId);
  if (!stored.ok) return { ok: false, error: stored.error };
  if (!String(stored.meta.fiscalNivf ?? '').trim()) {
    return { ok: false, error: 'not-fiscalized' };
  }
  const settings: any = await coreServices.readSettings();
  const { dispatchTicket } = await import('./printDispatcher');
  const result = await dispatchTicket(
    { ...stored.payload, meta: stored.meta } as any,
    settings,
    { persistRetryOnTransientFailure: false },
  ).catch(() => ({ ok: false }) as { ok: boolean });
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
