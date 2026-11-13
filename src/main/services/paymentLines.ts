/**
 * Checks on what a payment charges for, run inside the table's payment
 * lock by the till (`tickets:print`) and the LAN route (`/print/ticket`).
 *
 *  - A payment carries the key that stops a retry recording it twice.
 *    Every app the till accepts sends one; a payment without it was taken
 *    and could be recorded twice.
 *  - Every line is on the menu, or on the table's bill (`linePricing.ts`).
 *    A line on neither was charged at the phone's price.
 *  - A payment that leaves the table open (one seat's share) pays only for
 *    lines the bill has, unpaid, in at most the quantity it has. Only a
 *    payment that closes the table used to be compared with the bill.
 */
import { asTicketLogItems } from '@shared/ticketLogItems';
import { lineIdOf } from '@shared/ticketLineIds';
import { isStoreCounterArea } from '@shared/editionCapabilities';
import {
  APP_UPDATE_REQUIRED,
  appUpdateRequiredMessage,
} from '@shared/appVersion';
import type { LinePriceIssue } from './linePricing';
import type { PrintTicketErr } from './paymentSettle';
import { findLatestTicketLogForCurrentSession } from './tableSession';

export const PAYMENT_KEY_REQUIRED = APP_UPDATE_REQUIRED;
export const NOT_ON_MENU = 'NOT_ON_MENU';
export const SEAT_PAYMENT_NOT_ON_BILL = 'BILL_CHANGED';

type Line = Record<string, unknown>;
const EPS = 1e-6;

function qty(l: Line): number {
  const n = Number(l?.qty ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function itemKey(l: Line): string {
  const sku = String(l?.sku ?? '').trim();
  return sku
    ? `sku:${sku}`
    : `name:${String(l?.name ?? '')
        .trim()
        .toLowerCase()}`;
}

function live(l: Line): boolean {
  return l?.voided !== true && l?.paid !== true;
}

/**
 * What a seat payment pays for beyond the bill's unpaid lines. Lines named
 * by id must be that line, unpaid, in at most its quantity; the rest are
 * matched by item against what the named lines left.
 */
export function seatPaymentBeyondBill(
  bill: Line[],
  paying: Line[],
): Array<{ name: string; qty: number }> {
  const left = new Map<number, number>();
  bill.forEach((l, i) => {
    if (live(l)) left.set(i, qty(l));
  });
  const over: Array<{ name: string; qty: number }> = [];
  const loose: Line[] = [];
  for (const p of paying) {
    if (p?.voided === true) continue;
    const want = qty(p);
    if (want <= 0) continue;
    const id = lineIdOf(p);
    const at = id ? bill.findIndex((b) => lineIdOf(b) === id) : -1;
    if (at < 0) {
      loose.push(p);
      continue;
    }
    const have = left.get(at) ?? 0;
    if (want > have + EPS) {
      over.push({ name: String(p.name ?? 'Item'), qty: round(want - have) });
    }
    left.set(at, Math.max(0, have - want));
  }
  for (const p of loose) {
    let want = qty(p);
    const key = itemKey(p);
    for (const [i, have] of left) {
      if (want <= EPS) break;
      if (have <= EPS || itemKey(bill[i]) !== key) continue;
      const take = Math.min(have, want);
      left.set(i, have - take);
      want -= take;
    }
    if (want > EPS) {
      over.push({ name: String(p.name ?? 'Item'), qty: round(want) });
    }
  }
  return over;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function namesOf(items: Array<{ name: string; qty?: number | null }>): string {
  return items
    .slice(0, 5)
    .map((i) => (i.qty ? `${i.qty} x ${i.name}` : i.name))
    .join(', ');
}

/** Null when the payment may go ahead. */
export async function checkPaymentLines(input: {
  area: string;
  tableLabel: string;
  items: unknown;
  closeTable: boolean;
  idempotencyKey: string | null | undefined;
  refusedLines: LinePriceIssue[];
  /** The sitting already read under this lock (`paymentOwnership.ts`). */
  sitting?: { latest: unknown };
}): Promise<PrintTicketErr | null> {
  if (!String(input.idempotencyKey ?? '').trim()) {
    return {
      ok: false,
      code: PAYMENT_KEY_REQUIRED,
      error: appUpdateRequiredMessage(),
      permanent: true,
    };
  }
  if (input.refusedLines.length) {
    return {
      ok: false,
      code: NOT_ON_MENU,
      error: `${namesOf(
        input.refusedLines.map((l) => ({ name: l.name || l.sku || 'Item' })),
      )} is not on the menu. Refresh the menu and charge again.`,
      permanent: true,
    };
  }
  if (input.closeTable || isStoreCounterArea(input.area)) return null;
  const latest = input.sitting
    ? input.sitting.latest
    : await findLatestTicketLogForCurrentSession(input.area, input.tableLabel);
  const bill = asTicketLogItems((latest as any)?.itemsJson) as Line[];
  const over = seatPaymentBeyondBill(
    bill,
    Array.isArray(input.items) ? (input.items as Line[]) : [],
  );
  if (!over.length) return null;
  return {
    ok: false,
    code: SEAT_PAYMENT_NOT_ON_BILL,
    error: `This payment includes items that are not unpaid on the bill (${namesOf(over)}). Open the table again and charge again.`,
    permanent: true,
  };
}
