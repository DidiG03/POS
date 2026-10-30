/**
 * A payment that leaves the table open (one seat's share) marks the lines it
 * paid on the bill itself, at commit, under the table lock.
 *
 * Paid lines used to reach the bill only through the paying phone's next
 * Send: a copy of the bill with those lines flagged. A Send from another
 * phone that landed in between made that copy stale, and the paid flags were
 * dropped. The guest was then charged for the same items again. Since a Send
 * can no longer change a line the bill has (`ticketMerge.ts`), the payment
 * route is the only place the flags can come from.
 *
 * Lines are found by `lineId` (the bill line the device paid). A payment
 * from an older device without ids takes live, unpaid lines of the same
 * item, splitting one when only part of it was paid.
 */
import { asTicketLogItems } from '@shared/ticketLogItems';
import { lineIdOf } from '@shared/ticketLineIds';
import { ticketDraftLineKey } from '@shared/ticketDraft';
import type { MergeLine } from '@shared/ticketMerge';
import {
  findLatestTicketLogForCurrentSession,
  getCurrentTableSessionKey,
} from './tableSession';
import { writeTicketSnapshot } from './ticketLogWrite';

const EPS = 1e-9;

function qtyOf(line: { qty?: unknown }): number {
  const n = Number(line?.qty);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function isLive(line: MergeLine): boolean {
  return line.voided !== true && line.paid !== true;
}

/**
 * `bill` with the lines a payment covered marked paid. Returns null when
 * nothing on the bill changes.
 */
export function markPaidLines(
  bill: readonly MergeLine[],
  paid: readonly MergeLine[],
): MergeLine[] | null {
  const out = bill.map((l) => ({ ...l }));
  let changed = false;
  const loose: MergeLine[] = [];
  for (const line of paid) {
    const id = lineIdOf(line);
    const at = id ? out.findIndex((l) => lineIdOf(l) === id) : -1;
    if (at < 0) {
      loose.push(line);
      continue;
    }
    if (isLive(out[at])) {
      out[at] = { ...out[at], paid: true };
      changed = true;
    }
  }
  for (const line of loose) {
    const key = ticketDraftLineKey(line);
    let left = qtyOf(line);
    for (let i = 0; i < out.length && left > EPS; i++) {
      const cur = out[i];
      if (!isLive(cur) || cur.fired === false) continue;
      if (ticketDraftLineKey(cur) !== key) continue;
      const q = qtyOf(cur);
      if (q <= left + EPS) {
        out[i] = { ...cur, paid: true };
        left = roundQty(left - q);
      } else {
        // Part of the line was paid: split it, keeping the id on the rest.
        const paidPart = { ...cur, qty: roundQty(left), paid: true };
        delete (paidPart as MergeLine).lineId;
        out[i] = { ...cur, qty: roundQty(q - left) };
        out.splice(i, 0, paidPart);
        i += 1;
        left = 0;
      }
      changed = true;
    }
  }
  return changed ? out : null;
}

/**
 * Write the bill with the paid lines flagged. Must run while holding the
 * table lock (inside the payment). Idempotent per payment key.
 */
export async function recordPaidLinesOnBill(input: {
  area: string;
  tableLabel: string;
  items: unknown[];
  userId: number;
  paymentKey?: string | null;
}): Promise<boolean> {
  const latest = await findLatestTicketLogForCurrentSession(
    input.area,
    input.tableLabel,
  ).catch(() => null);
  if (!latest) return false;
  const bill = asTicketLogItems((latest as any).itemsJson) as MergeLine[];
  const next = markPaidLines(
    bill,
    (Array.isArray(input.items) ? input.items : []) as MergeLine[],
  );
  if (!next) return false;
  const key = String(input.paymentKey || '').trim();
  const outcome = await writeTicketSnapshot({
    userId: Number((latest as any).userId) || Number(input.userId) || 0,
    area: input.area,
    tableLabel: input.tableLabel,
    covers: (latest as any).covers ?? null,
    items: next,
    note: (latest as any).note ?? null,
    idempotencyKey: key ? `paid:${key}` : null,
    sessionKey: await getCurrentTableSessionKey(
      input.area,
      input.tableLabel,
    ).catch(() => null),
    stockConsumeLines: [],
  });
  return outcome === 'written';
}
