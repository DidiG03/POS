/**
 * Who may take payment on a table.
 *
 * Any signed-in waiter could charge a colleague's table, so a bill could be
 * closed (and its cash pocketed) by someone who never served it, and the
 * waiter who did only found the table gone. The rule now matches voids:
 *
 *   - the waiter who owns the sitting pays it;
 *   - a CASHIER or ADMIN may pay any table (that is the cashier's job);
 *   - anyone else is refused, and told whose table it is.
 *
 * When a cashier or admin pays another waiter's table, that waiter is told.
 */
import { prisma } from '@db/client';
import { readCurrentSitting, type CurrentSitting } from './tableSession';

const PAYS_ANY_TABLE = new Set(['ADMIN', 'CASHIER']);

export function paymentBlockedByOtherOwner(input: {
  actorRole: string | null | undefined;
  actorUserId: number;
  ownerId: number | null;
}): boolean {
  if (PAYS_ANY_TABLE.has(String(input.actorRole || '').toUpperCase()))
    return false;
  return (
    input.ownerId !== null &&
    Number(input.ownerId) !== Number(input.actorUserId)
  );
}

export type PaymentOwnership =
  // `sitting`: what was read to decide, so the stale-bill check that runs
  // next under the same lock does not read it again (perf, QA v0.2.103).
  | { ok: true; ownerId: number | null; sitting?: CurrentSitting }
  | {
      ok: false;
      code: 'TABLE_OWNED_BY_OTHER';
      error: string;
      permanent: true;
      ownerId: number;
    };

export async function checkPaymentOwnership(input: {
  area: string;
  tableLabel: string;
  actorUserId: number;
  actorRole: string | null | undefined;
}): Promise<PaymentOwnership> {
  const sitting = await readCurrentSitting(input.area, input.tableLabel).catch(
    () => null,
  );
  const ownerId = sitting?.latest ? Number(sitting.latest.userId) : null;
  if (
    !paymentBlockedByOtherOwner({
      actorRole: input.actorRole,
      actorUserId: input.actorUserId,
      ownerId,
    })
  ) {
    return { ok: true, ownerId, ...(sitting ? { sitting } : {}) };
  }
  const owner = await prisma.user
    .findUnique({ where: { id: Number(ownerId) } })
    .catch(() => null);
  const name = (owner as any)?.displayName || `waiter #${ownerId}`;
  return {
    ok: false,
    code: 'TABLE_OWNED_BY_OTHER',
    error: `This table is ${name}'s. Ask ${name}, a cashier or a manager to take the payment, or transfer the table first.`,
    permanent: true,
    ownerId: Number(ownerId),
  };
}

/** Tell the owner that a cashier/admin took payment on their table. */
export async function notifyOwnerOfPayment(input: {
  area: string;
  tableLabel: string;
  ownerId: number | null;
  actorUserId: number;
}): Promise<void> {
  if (!input.ownerId || Number(input.ownerId) === Number(input.actorUserId))
    return;
  const actor = await prisma.user
    .findUnique({ where: { id: Number(input.actorUserId) } })
    .catch(() => null);
  const who = (actor as any)?.displayName || `#${input.actorUserId}`;
  await prisma.notification
    .create({
      data: {
        userId: Number(input.ownerId),
        type: 'OTHER' as any,
        message: `${who} took payment on your table ${input.area} ${input.tableLabel}`,
      } as any,
    })
    .catch(() => undefined);
}
