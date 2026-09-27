/**
 * Notifications that must reach someone who can act on them.
 *
 * Used for conditions the software cannot resolve on its own — an
 * indeterminate fiscal outcome, a lost payment audit row — where failing
 * quietly means nobody ever finds out.
 */

import { prisma } from '@db/client';
import { isPaymentReprint } from './paymentSettle';

export type AdminAlertType = 'SECURITY' | 'OTHER';

/**
 * One line for the admin feed when a payment includes a discount.
 * Returns null when this sale should not produce that notice.
 */
export function paymentDiscountAlertMessage(input: {
  area: string;
  tableLabel: string;
  meta: unknown;
}): string | null {
  const meta = (input.meta || {}) as Record<string, unknown>;
  const kind = String(meta.kind || '').toUpperCase();
  const userId = Number(meta.userId || 0);
  const discountAmt = Number(meta.discountAmount || 0);
  if (
    kind !== 'PAYMENT' ||
    isPaymentReprint(meta) ||
    !userId ||
    !Number.isFinite(discountAmt) ||
    discountAmt <= 0
  ) {
    return null;
  }
  const before = Number(meta.totalBefore ?? meta.total ?? 0);
  const after = Number(meta.totalAfter ?? Math.max(0, before - discountAmt));
  const dtype = String(meta.discountType || '').toUpperCase();
  const dval = meta.discountValue;
  const dLabel =
    dtype === 'PERCENT' && Number.isFinite(Number(dval))
      ? `${Number(dval)}%`
      : dtype === 'AMOUNT' && Number.isFinite(Number(dval))
        ? `${Number(dval).toFixed(2)}`
        : 'custom';
  const reason = String(meta.discountReason || '').trim();
  const approvedBy = String(meta.managerApprovedByName || '').trim();
  return (
    `Discount applied (${dLabel}) on ${input.area} Table ${input.tableLabel}: -${discountAmt.toFixed(2)} ` +
    `(total ${before.toFixed(2)} → ${after.toFixed(2)})` +
    `${meta.method ? ` · method ${String(meta.method)}` : ''}` +
    `${reason ? ` · reason: ${reason}` : ''}` +
    `${approvedBy ? ` · approved by: ${approvedBy}` : ' · NO MANAGER APPROVAL'}`
  );
}

export async function notifyPaymentDiscount(input: {
  area: string;
  tableLabel: string;
  meta: unknown;
}): Promise<void> {
  const message = paymentDiscountAlertMessage(input);
  if (!message) return;
  const userId = Number(
    ((input.meta || {}) as { userId?: unknown }).userId || 0,
  );
  await notifyAdminsAndActor({ message, actorUserId: userId });
}

export async function notifyAdminsAndActor(input: {
  message: string;
  actorUserId?: number;
  type?: AdminAlertType;
}): Promise<void> {
  const recipients = new Set<number>();
  if (input.actorUserId && Number.isFinite(input.actorUserId)) {
    recipients.add(Number(input.actorUserId));
  }
  const admins = await prisma.user
    .findMany({
      where: { role: 'ADMIN', active: true } as any,
      select: { id: true },
      take: 50,
    })
    .catch(() => [] as Array<{ id: number }>);
  for (const a of admins) recipients.add(Number(a.id));

  for (const userId of recipients) {
    await prisma.notification
      .create({
        data: {
          userId,
          type: (input.type || 'OTHER') as any,
          message: input.message,
        } as any,
      })
      .catch(() => undefined);
  }
}

/**
 * The `PrintJob` row written after a payment is the receipt, the revenue
 * line in the shift summary, and the guard that stops a retry from
 * recording the sale twice. If that insert fails there is no local record
 * of the payment at all — and when it was fiscalized, the tax service is
 * holding an invoice this POS cannot produce. Swallowing that is how a
 * till ends up short with no explanation.
 */
export async function reportAuditWriteFailure(input: {
  area?: string;
  tableLabel?: string;
  actorUserId?: number;
  error: string;
}): Promise<void> {
  const where = [input.area, input.tableLabel && `Table ${input.tableLabel}`]
    .filter(Boolean)
    .join(' ');
  const message =
    `Receipt audit row could not be saved${where ? ` for ${where}` : ''}: ${input.error}` +
    ' · This payment may be missing from receipt history and the shift summary.';
  console.error(`[payment-audit] ${message}`);
  await notifyAdminsAndActor({
    message,
    actorUserId: input.actorUserId,
    type: 'SECURITY',
  });
}
