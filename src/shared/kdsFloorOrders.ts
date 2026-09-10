export type KdsFloorOrderItem = {
  name: string;
  qty?: number;
  note?: string;
  station?: string;
  voided?: boolean;
  bumped?: boolean;
  ready?: boolean;
  cookerBumped?: boolean;
  waiterBumped?: boolean;
  _idx?: number;
};

export type KdsFloorOrder = {
  ticketId: number;
  orderNo: number;
  area: string;
  tableLabel: string;
  waiterName?: string | null;
  waiterUserId?: number | null;
  firedAt: string | null;
  note?: string | null;
  items: KdsFloorOrderItem[];
};

type FloorTicketBatch = {
  station: string;
  tickets: Array<{
    ticketId?: number;
    orderNo?: number;
    area?: string;
    tableLabel?: string;
    waiterName?: string | null;
    waiterUserId?: number | null;
    firedAt?: string | null;
    note?: string | null;
    items?: unknown[];
  }>;
};

export function toKdsFloorOrderItem(
  raw: unknown,
  fallbackStation: string,
  idx?: number,
): KdsFloorOrderItem {
  const it = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const station = String(it.station || fallbackStation || '')
    .trim()
    .toUpperCase();
  const cookerBumped = it.cookerBumped === true;
  const voided = it.voided === true;
  return {
    name: String(it.name || ''),
    qty: it.qty != null ? Number(it.qty) : undefined,
    note: it.note ? String(it.note) : undefined,
    station: station || undefined,
    voided,
    bumped: it.bumped === true,
    cookerBumped,
    waiterBumped: it.waiterBumped === true,
    ready: it.ready === true || (cookerBumped && !voided),
    _idx: Number.isFinite(Number(it._idx))
      ? Number(it._idx)
      : idx != null
        ? idx
        : undefined,
  };
}

/** Still live on a KDS station. Leaves the waiter board when kitchen bumps it. */
export function kdsItemLiveOnStation(item: KdsFloorOrderItem): boolean {
  if (item.voided === true) return false;
  if (item.bumped === true) return false;
  return Boolean(String(item.station || '').trim());
}

export function floorItemsFromTicket(
  itemsAll: unknown[],
  enabledStations: ReadonlySet<string>,
): KdsFloorOrderItem[] {
  const list = Array.isArray(itemsAll) ? itemsAll : [];
  const out: KdsFloorOrderItem[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    const item = toKdsFloorOrderItem(list[idx], '', idx);
    const station = String(item.station || '').toUpperCase();
    if (!station || !enabledStations.has(station)) continue;
    if (!kdsItemLiveOnStation(item)) continue;
    out.push(item);
  }
  return out;
}

/** Collapse per-station KDS cards into one waiter-facing ticket. */
export function mergeKdsTicketsForFloor(
  batches: FloorTicketBatch[],
): KdsFloorOrder[] {
  const byId = new Map<number, KdsFloorOrder>();
  for (const { station, tickets } of batches) {
    const st = String(station || '').toUpperCase();
    for (const ticket of tickets) {
      const ticketId = Number(ticket.ticketId);
      if (!ticketId) continue;
      const items = (Array.isArray(ticket.items) ? ticket.items : []).map(
        (item, idx) => toKdsFloorOrderItem(item, st, idx),
      );
      const existing = byId.get(ticketId);
      if (!existing) {
        byId.set(ticketId, {
          ticketId,
          orderNo: Number(ticket.orderNo || 0),
          area: String(ticket.area || ''),
          tableLabel: String(ticket.tableLabel || ''),
          waiterName: ticket.waiterName ?? null,
          waiterUserId: ticket.waiterUserId ?? null,
          firedAt: ticket.firedAt ?? null,
          note: ticket.note ?? null,
          items,
        });
        continue;
      }
      existing.items.push(...items);
      if (
        ticket.firedAt &&
        (!existing.firedAt || ticket.firedAt < existing.firedAt)
      ) {
        existing.firedAt = ticket.firedAt;
      }
      if (!existing.waiterName && ticket.waiterName) {
        existing.waiterName = ticket.waiterName;
      }
      if (existing.waiterUserId == null && ticket.waiterUserId != null) {
        existing.waiterUserId = ticket.waiterUserId;
      }
      if (!existing.note && ticket.note) existing.note = ticket.note;
    }
  }

  return [...byId.values()]
    .filter((order) => order.items.length > 0)
    .sort((a, b) =>
      String(a.firedAt || '').localeCompare(String(b.firedAt || '')),
    );
}
