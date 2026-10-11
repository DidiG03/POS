import { prisma } from '@db/client';
import { isStoreCounterArea } from '@shared/editionCapabilities';
import { asTicketLogItems, ticketLogCreatedAtMs } from '@shared/ticketLogItems';
import {
  findLatestTicketLogSince,
  getTableSessionStartedAt,
} from './tableSession';
import type { PrintTicketErr } from './paymentSettle';

/**
 * A payment carries its own item list: whatever the paying device had on
 * screen. When another device added to the table after that screen loaded,
 * the till used to record the smaller total, close the table and drop the
 * added items without a word. A payment that closes the table must now
 * cover the whole bill.
 *
 * Lenient on purpose: anything already paid in this sitting (seat
 * payments) counts, and paying for more than the bill is fine (lines the
 * till has not received yet). Only lines nobody is paying for block it.
 */

type LineLike = {
  sku?: unknown;
  name?: unknown;
  qty?: unknown;
  voided?: unknown;
  paid?: unknown;
};

const EPS = 1e-6;

function lineKey(l: LineLike): string {
  const sku = String(l?.sku ?? '').trim();
  if (sku) return `sku:${sku}`;
  return `name:${String(l?.name ?? '')
    .trim()
    .toLowerCase()}`;
}

function addQty(
  into: Map<string, { name: string; qty: number }>,
  lines: LineLike[],
  sign = 1,
): void {
  for (const l of lines) {
    const qty = Number(l?.qty ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const key = lineKey(l);
    const cur = into.get(key) || {
      name: String(l?.name ?? '').trim() || key,
      qty: 0,
    };
    cur.qty += sign * qty;
    into.set(key, cur);
  }
}

/** Bill lines (not voided, not paid) that neither earlier payments nor this one cover. */
export function uncoveredBillLines(input: {
  bill: LineLike[];
  paidEarlier: LineLike[];
  paying: LineLike[];
}): Array<{ name: string; qty: number }> {
  const owed = new Map<string, { name: string; qty: number }>();
  addQty(
    owed,
    input.bill.filter((l) => l?.voided !== true && l?.paid !== true),
  );
  addQty(owed, input.paidEarlier, -1);
  addQty(owed, input.paying, -1);
  return [...owed.values()]
    .filter((v) => v.qty > EPS)
    .map((v) => ({ name: v.name, qty: Math.round(v.qty * 1000) / 1000 }));
}

export function billChangedResult(
  missing: Array<{ name: string; qty: number }>,
): PrintTicketErr {
  const list = missing
    .slice(0, 5)
    .map((m) => `${m.qty} x ${m.name}`)
    .join(', ');
  return {
    ok: false,
    code: 'BILL_CHANGED',
    // Replaying the same payment cannot succeed; the waiter has to reopen
    // the table and charge the new total.
    permanent: true,
    error: `The bill changed on another device (${list}). Open the table again and charge the new total.`,
  };
}

/**
 * Null when the payment covers the current bill. Must run inside the
 * table's payment lock so the bill cannot change between check and close.
 */
export async function findStaleBillPayment(input: {
  area: string;
  tableLabel: string;
  items: LineLike[];
}): Promise<PrintTicketErr | null> {
  const area = String(input.area || '');
  const tableLabel = String(input.tableLabel || '');
  if (!area || !tableLabel || isStoreCounterArea(area)) return null;
  const since = await getTableSessionStartedAt(area, tableLabel);
  if (!since) return null;
  const latest = await findLatestTicketLogSince(area, tableLabel, since);
  if (!latest) return null;
  const bill = asTicketLogItems((latest as any).itemsJson) as LineLike[];
  if (!bill.length) return null;

  const sinceMs = since.getTime();
  const recentOrders = (await prisma.order
    .findMany({
      where: { area, tableLabel, status: 'PAID' } as any,
      orderBy: { id: 'desc' },
      take: 20,
      include: { items: true },
    })
    .catch(() => [])) as any[];
  const paidEarlier = recentOrders
    .filter((o) => ticketLogCreatedAtMs(o.closedAt ?? o.createdAt) >= sinceMs)
    .flatMap((o) => (Array.isArray(o.items) ? o.items : []))
    .map((it: any) => ({ sku: it.sku, name: it.name, qty: Number(it.qty) }));

  const missing = uncoveredBillLines({
    bill,
    paidEarlier,
    paying: Array.isArray(input.items) ? input.items : [],
  });
  return missing.length ? billChangedResult(missing) : null;
}
