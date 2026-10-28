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

/** A repeat of the same request inside this window is a retry, not a second ask. */
export const REQUEST_RETRY_WINDOW_MS = 60_000;

/**
 * Ask a table's owner to add items. Shared by the till (`requests:create`)
 * and phones (`POST /requests/create`).
 *
 * The phone route never told the owner, so a request sat unseen until the
 * owner opened their list. And a phone retries a POST that failed after the
 * request was sent, which created the same request twice; approving both
 * added the items twice. An identical PENDING request from the same waiter
 * within {@link REQUEST_RETRY_WINDOW_MS} is now treated as that retry.
 */
export async function createTicketRequest(input: {
  requesterId: number;
  ownerId: number;
  area: string;
  tableLabel: string;
  items: unknown[];
  note?: string | null;
  now?: number;
}): Promise<{ id: number; created: boolean }> {
  const now = input.now ?? Date.now();
  const area = String(input.area);
  const tableLabel = String(input.tableLabel);
  const note = input.note ? String(input.note) : null;
  const itemsKey = JSON.stringify(input.items ?? []);

  const recent = (await prisma.ticketRequest
    .findMany({
      where: {
        requesterId: Number(input.requesterId),
        ownerId: Number(input.ownerId),
        area,
        tableLabel,
        status: 'PENDING' as any,
        createdAt: { gte: new Date(now - REQUEST_RETRY_WINDOW_MS) },
      },
      orderBy: { id: 'desc' },
      take: 5,
    } as any)
    .catch(() => [])) as any[];
  const repeat = recent.find(
    (r) =>
      JSON.stringify(r.itemsJson ?? []) === itemsKey &&
      (r.note ?? null) === note,
  );
  if (repeat) return { id: Number(repeat.id), created: false };

  const created = await prisma.ticketRequest.create({
    data: {
      requesterId: Number(input.requesterId),
      ownerId: Number(input.ownerId),
      area,
      tableLabel,
      itemsJson: input.items as any,
      note,
      status: 'PENDING' as any,
    },
  });

  const requester = await prisma.user
    .findUnique({ where: { id: Number(input.requesterId) } })
    .catch(() => null);
  const msg = `${(requester as any)?.displayName || 'Staff'} requested to add items on ${area} ${tableLabel} (Request #${created.id})`;
  await prisma.notification
    .create({
      data: {
        userId: Number(input.ownerId),
        type: 'OTHER' as any,
        message: msg,
      },
    })
    .catch(() => undefined);
  return { id: Number(created.id), created: true };
}

/**
 * Mark approved requests as added to the bill. Only the table owner the
 * request was addressed to, or an admin, may: any waiter used to be able to
 * mark a colleague's approved request applied, and it vanished from the
 * owner's screen before its items were ever added. Returns how many changed.
 */
export async function markTicketRequestsApplied(input: {
  ids: unknown[];
  actorUserId: number;
  actorIsAdmin: boolean;
}): Promise<number> {
  const ids = (Array.isArray(input.ids) ? input.ids : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(0, 200);
  const actor = Number(input.actorUserId);
  if (!ids.length || (!input.actorIsAdmin && !(actor > 0))) return 0;
  const updated = await prisma.ticketRequest.updateMany({
    where: {
      id: { in: ids },
      status: 'APPROVED' as any,
      ...(input.actorIsAdmin ? {} : { ownerId: actor }),
    },
    data: { status: 'APPLIED' as any, decidedAt: new Date() },
  } as any);
  return Number(updated?.count || 0);
}
