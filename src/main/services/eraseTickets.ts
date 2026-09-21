import { prisma } from '@db/client';
import { invalidateFloorSnapshotCache } from './floorSnapshot';
import { broadcastTableStatusChanged } from './realtime';

/** Typed into the Disk protection confirm field. Same in every locale. */
export const ERASE_TICKETS_CONFIRM = 'ERASE';

export function eraseTicketsConfirmMatches(value: unknown): boolean {
  return (
    String(value || '')
      .trim()
      .toUpperCase() === ERASE_TICKETS_CONFIRM
  );
}

type CountResult = { count: number };

type EraseClient = {
  kdsTicketStation: { deleteMany: (args?: object) => Promise<CountResult> };
  kdsTicket: { deleteMany: (args?: object) => Promise<CountResult> };
  kdsOrder: { deleteMany: (args?: object) => Promise<CountResult> };
  kdsDayCounter: { deleteMany: (args?: object) => Promise<CountResult> };
  orderItemModifier: { deleteMany: (args?: object) => Promise<CountResult> };
  orderItem: { deleteMany: (args?: object) => Promise<CountResult> };
  payment: { deleteMany: (args?: object) => Promise<CountResult> };
  saleCorrection: { deleteMany: (args?: object) => Promise<CountResult> };
  order: { deleteMany: (args?: object) => Promise<CountResult> };
  ticketLog: { deleteMany: (args?: object) => Promise<CountResult> };
  ticketRequest: { deleteMany: (args?: object) => Promise<CountResult> };
  covers: { deleteMany: (args?: object) => Promise<CountResult> };
  tableOccupancy: {
    findMany: (
      args?: object,
    ) => Promise<Array<{ area: string; label: string }>>;
    deleteMany: (args?: object) => Promise<CountResult>;
  };
  syncState: {
    deleteMany: (args: object) => Promise<CountResult>;
  };
  $transaction?: <T>(fn: (tx: EraseClient) => Promise<T>) => Promise<T>;
};

export type EraseTicketsResult = {
  ok: true;
  ticketLogs: number;
  orders: number;
  kdsOrders: number;
  openTables: number;
};

async function wipeTicketRows(tx: EraseClient): Promise<EraseTicketsResult> {
  await tx.kdsTicketStation.deleteMany();
  await tx.kdsTicket.deleteMany();
  const kdsOrders = await tx.kdsOrder.deleteMany();
  await tx.kdsDayCounter.deleteMany();
  await tx.orderItemModifier.deleteMany();
  await tx.orderItem.deleteMany();
  await tx.payment.deleteMany();
  await tx.saleCorrection.deleteMany();
  const orders = await tx.order.deleteMany();
  const ticketLogs = await tx.ticketLog.deleteMany();
  await tx.ticketRequest.deleteMany();
  await tx.covers.deleteMany();
  const occupancy = await tx.tableOccupancy.deleteMany();
  await tx.syncState.deleteMany({
    where: { key: { in: ['tables:open', 'tables:openAt'] } },
  });
  return {
    ok: true,
    ticketLogs: Number(ticketLogs?.count || 0),
    orders: Number(orders?.count || 0),
    kdsOrders: Number(kdsOrders?.count || 0),
    openTables: Number(occupancy?.count || 0),
  };
}

/**
 * Permanently deletes every kitchen ticket, paid sale, and open sitting.
 * Menu, staff, settings, and the vault stay. Occupied tables are freed so
 * the floor does not keep ghost bills.
 */
export async function eraseAllTickets(
  client: EraseClient = prisma as unknown as EraseClient,
): Promise<EraseTicketsResult> {
  const occupied = await client.tableOccupancy
    .findMany({ select: { area: true, label: true } })
    .catch(() => []);

  const result =
    typeof client.$transaction === 'function'
      ? await client
          .$transaction((tx) => wipeTicketRows(tx))
          .catch(() => wipeTicketRows(client))
      : await wipeTicketRows(client);

  invalidateFloorSnapshotCache();
  for (const row of occupied) {
    const area = String(row?.area || '').trim();
    const label = String(row?.label || '').trim();
    if (!area || !label) continue;
    broadcastTableStatusChanged({ area, label, open: false });
  }
  return result;
}
