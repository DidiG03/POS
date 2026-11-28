/**
 * Where each sent line of a table's bill is in the kitchen: on the display
 * (IN_KITCHEN) or bumped (DONE). Read from the open KDS order of the table;
 * lines are matched by their bill line id, which KDS items carry. A sent
 * line that is on no display (bar without a KDS, KDS off) is not listed:
 * the phone shows it as "Sent".
 */
import { prisma } from '@db/client';

export type KitchenLineStatus = 'IN_KITCHEN' | 'DONE';

/** Pure: per line id, from KDS tickets with their station rows. */
export function kitchenStatusFromTickets(
  tickets: Array<{
    itemsJson: unknown;
    stations?: Array<{ station: string; status: string }>;
  }>,
): Record<string, KitchenLineStatus> {
  const out: Record<string, KitchenLineStatus> = {};
  for (const t of tickets) {
    const items = Array.isArray(t.itemsJson) ? (t.itemsJson as any[]) : [];
    const doneStations = new Set(
      (t.stations || [])
        .filter((s) => String(s.status).toUpperCase() === 'DONE')
        .map((s) => String(s.station).toUpperCase()),
    );
    for (const it of items) {
      const id = String(it?.lineId || '').trim();
      if (!id || it?.voided) continue;
      const station = String(it?.station || 'KITCHEN').toUpperCase();
      const done = it?.bumped === true || doneStations.has(station);
      // A line on two cards (re-fired): in the kitchen until all are done.
      if (out[id] === 'IN_KITCHEN') continue;
      out[id] = done ? 'DONE' : 'IN_KITCHEN';
    }
  }
  return out;
}

export async function kitchenStatusForTable(
  area: string,
  tableLabel: string,
): Promise<Record<string, KitchenLineStatus>> {
  if (!area || !tableLabel) return {};
  const order: any = await (prisma as any).kdsOrder
    .findFirst({
      where: { area, tableLabel, closedAt: null },
      orderBy: { id: 'desc' },
      include: {
        tickets: {
          select: {
            itemsJson: true,
            stations: { select: { station: true, status: true } },
          },
        },
      },
    })
    .catch(() => null);
  return order ? kitchenStatusFromTickets(order.tickets || []) : {};
}
