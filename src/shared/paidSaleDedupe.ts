import { ticketLogCreatedAtMs } from './ticketLogItems';

/** Guest-slip reprint payload — must never count as a second sale. */
export function isPaidSaleReprintMeta(meta: unknown): boolean {
  const m = (meta || {}) as { kind?: string; reprint?: boolean };
  return String(m.kind || '').toUpperCase() === 'PAYMENT' && m.reprint === true;
}

type SettlementOrder = {
  id?: number;
  userId?: number | null;
  area?: string | null;
  tableLabel?: string | null;
  total?: number | null;
  closedAt?: unknown;
  createdAt?: unknown;
  payments?: Array<{
    metaJson?: unknown;
    fiscalNslf?: string | null;
    fiscalNivf?: string | null;
  }>;
};

function settlementKey(order: SettlementOrder): string {
  const at = ticketLogCreatedAtMs(order.closedAt ?? order.createdAt);
  return [
    Number(order.userId) || 0,
    String(order.area || ''),
    String(order.tableLabel || ''),
    Number.isFinite(at) ? at : 0,
    Number(order.total) || 0,
  ].join('|');
}

function hasFiscalMarks(order: SettlementOrder): boolean {
  const pay = order.payments?.[0];
  return Boolean(
    String(pay?.fiscalNslf || '').trim() ||
      String(pay?.fiscalNivf || '').trim(),
  );
}

/**
 * Drop reprint-spawned Orders and collapse accidental double-writes of the
 * same settlement (same waiter/table/time/total). Prefers the fiscalized row.
 */
export function keepCanonicalPaidOrders<T extends SettlementOrder>(
  orders: T[],
): T[] {
  const real = orders.filter(
    (o) => !isPaidSaleReprintMeta(o.payments?.[0]?.metaJson),
  );
  const ranked = [...real].sort((a, b) => {
    const af = hasFiscalMarks(a) ? 1 : 0;
    const bf = hasFiscalMarks(b) ? 1 : 0;
    if (bf !== af) return bf - af;
    return Number(a.id || 0) - Number(b.id || 0);
  });
  const seen = new Set<string>();
  const out: T[] = [];
  for (const order of ranked) {
    const key = settlementKey(order);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(order);
  }
  return out;
}
