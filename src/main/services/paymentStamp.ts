/**
 * Who took a payment, and when, as the till knows them.
 *
 * A payment request carries the staff member's id and name and the time
 * on the device. The sale, the staff reports and the operator the invoice
 * is filed under were all written from those. They now come from the
 * signed-in session and this till's clock; what the device sent is kept
 * beside them only where it differs.
 *
 * Reports reprints are left alone: they show a past sale as it was.
 */
import { prisma } from '@db/client';

export interface PaymentActor {
  userId: number;
  displayName?: string | null;
}

function isLivePayment(payload: any): boolean {
  const meta = payload?.meta;
  return (
    String(meta?.kind || '').toUpperCase() === 'PAYMENT' &&
    meta?.reprint !== true
  );
}

/** Pure core. Returns the payload unchanged when it is not a live payment. */
export function stampPayment<T>(
  payload: T,
  actor: PaymentActor | null,
  now: Date = new Date(),
): T {
  if (!isLivePayment(payload)) return payload;
  const p = payload as any;
  const meta: Record<string, any> = { ...(p.meta || {}) };
  const next: any = { ...p, meta };

  const sentAt = String(meta.paidAt || '').trim();
  meta.paidAt = now.toISOString();
  if (sentAt && sentAt !== meta.paidAt) meta.devicePaidAt = sentAt;

  const actorId = Number(actor?.userId || 0);
  if (Number.isInteger(actorId) && actorId > 0) {
    const sentId = Number(meta.userId || 0);
    if (sentId && sentId !== actorId) meta.deviceUserId = sentId;
    meta.userId = actorId;
    const name = String(actor?.displayName || '').trim();
    if (name) next.userName = name;
    else if (sentId !== actorId) delete next.userName;
  }
  return next as T;
}

/** {@link stampPayment} for a signed-in user id, with their name read here. */
export async function stampPaymentForSession<T>(
  payload: T,
  sessionUserId: unknown,
  now: Date = new Date(),
): Promise<T> {
  if (!isLivePayment(payload)) return payload;
  const userId = Number(sessionUserId || 0);
  if (!Number.isInteger(userId) || userId <= 0) {
    return stampPayment(payload, null, now);
  }
  const user = await (prisma as any).user
    .findUnique({ where: { id: userId }, select: { displayName: true } })
    .catch(() => null);
  return stampPayment(
    payload,
    { userId, displayName: user?.displayName ?? null },
    now,
  );
}
