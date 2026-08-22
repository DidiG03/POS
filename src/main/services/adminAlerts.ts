/**
 * Notifications that must reach someone who can act on them.
 *
 * Used for conditions the software cannot resolve on its own — an
 * indeterminate fiscal outcome, a lost payment audit row — where failing
 * quietly means nobody ever finds out.
 */

import { prisma } from '@db/client';

export type AdminAlertType = 'SECURITY' | 'OTHER';

/**
 * Notify every active admin, plus the staff member who triggered the
 * action so they know their own sale needs attention.
 */
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
