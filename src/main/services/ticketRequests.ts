/**
 * Deciding a colleague's "add items to my table" request.
 *
 * Approving only changes the request's status. The owner's order screen
 * polls approved requests for the table it has open, adds the items to the
 * live ticket, and sends them like any other line (`requests:pollApproved`
 * then `requests:markApplied`).
 *
 * The till used to also rewrite the table's latest TicketLog on approve. It
 * rebuilt every line from name/qty/price/VAT only, merged lines by name, and
 * so dropped each line's paid, voided, seat and course flags — and then the
 * owner's screen added the same items a second time. The phone path never
 * did that, so both now share this one implementation.
 */
import { prisma } from '@db/client';

export type TicketRequestDecision = 'APPROVED' | 'REJECTED';

/**
 * Decide a PENDING request addressed to `ownerId`. Returns false when the
 * request does not exist, belongs to someone else, or was already decided.
 */
export async function decideTicketRequest(input: {
  id: number;
  ownerId: number;
  decision: TicketRequestDecision;
}): Promise<boolean> {
  const id = Number(input.id);
  const ownerId = Number(input.ownerId);
  if (!Number.isFinite(id) || id <= 0) return false;
  if (!Number.isFinite(ownerId) || ownerId <= 0) return false;

  // One conditional write: two taps (or the till and a phone) cannot both
  // decide the same request.
  const updated = await prisma.ticketRequest.updateMany({
    where: { id, ownerId, status: 'PENDING' as any },
    data: { status: input.decision as any, decidedAt: new Date() },
  });
  if (!updated?.count) return false;

  const request = await prisma.ticketRequest
    .findUnique({ where: { id } })
    .catch(() => null);
  if (request) {
    const verb = input.decision === 'APPROVED' ? 'approved' : 'rejected';
    await prisma.notification
      .create({
        data: {
          userId: Number(request.requesterId),
          type: 'OTHER' as any,
          message: `Your request #${id} on ${request.area} ${request.tableLabel} was ${verb}`,
        },
      })
      .catch(() => undefined);
  }
  return true;
}
