/**
 * How the till applies one Send to the bill it already holds.
 *
 * A Send carries the whole bill as the sending device saw it. Writing that
 * snapshot as-is let the last writer win: a Send queued offline and replayed
 * after a newer one, or two devices adding to the same table, silently took
 * items off the bill the kitchen had already made, and a void that landed in
 * between came back as a live line. The till holds the table lock while it
 * decides, so this is the one place where "what is on the bill" is settled.
 *
 * Rules, all applied against the latest bill of the current sitting:
 *   - A line only leaves the bill by being voided or paid, each through its
 *     own channel. Live lines the Send does not account for are kept.
 *   - Voids and payments recorded on the bill stay voided and paid.
 *   - A Send built before the latest bill was written (`stale`) only adds the
 *     lines it fired (`addedItems`); the rest of its snapshot is out of date.
 *   - Lines fired by this Send carry `sendKey`. If the bill already holds
 *     any of them, a later Send included this one and nothing is added again.
 *   - A Send cannot void. Voids need a manager PIN and leave an audit trail,
 *     and go through their own route; a `voided` flag in a snapshot beyond
 *     what the bill already records is ignored. (A void the till refused
 *     used to come back on the waiter's next Send and stick.)
 */
import {
  restoreMissingServerLines,
  ticketDraftLineKey,
  type TicketDraftLine,
} from './ticketDraft';

export type MergeLine = TicketDraftLine & {
  sendKey?: string;
  [extra: string]: unknown;
};

export type TicketSendMergeMode =
  /** Written as sent: nothing on the bill was missing from it. */
  | 'as-sent'
  /** Lines or voids/payments from the bill were put back. */
  | 'restored'
  /** Built on an older bill: only its new lines were added. */
  | 'stale-delta'
  /** A later Send already carried these lines; the bill is unchanged. */
  | 'already-included';

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
 * Make sure every quantity the bill records as voided or paid is voided or
 * paid in `result` too, converting live lines of the same item (splitting a
 * line when only part of it is needed). A stale snapshot cannot resurrect
 * a voided item or charge a paid one again.
 */
export function carryVoidAndPaid<T extends MergeLine>(
  result: T[],
  bill: readonly MergeLine[],
): { items: T[]; changed: boolean } {
  const want = new Map<string, { voided: number; paid: number }>();
  for (const line of bill) {
    if (line.voided !== true && line.paid !== true) continue;
    const key = ticketDraftLineKey(line);
    const entry = want.get(key) || { voided: 0, paid: 0 };
    // A paid line that was later voided counts as paid: money was taken.
    if (line.paid === true) entry.paid += qtyOf(line);
    else entry.voided += qtyOf(line);
    want.set(key, entry);
  }
  if (want.size === 0) return { items: result, changed: false };

  const have = new Map<string, { voided: number; paid: number }>();
  for (const line of result) {
    if (line.voided !== true && line.paid !== true) continue;
    const key = ticketDraftLineKey(line);
    const entry = have.get(key) || { voided: 0, paid: 0 };
    if (line.paid === true) entry.paid += qtyOf(line);
    else entry.voided += qtyOf(line);
    have.set(key, entry);
  }

  const deficit = new Map<string, { voided: number; paid: number }>();
  for (const [key, w] of want) {
    const h = have.get(key) || { voided: 0, paid: 0 };
    const d = {
      paid: Math.max(0, w.paid - h.paid),
      voided: Math.max(0, w.voided - h.voided),
    };
    if (d.paid > EPS || d.voided > EPS) deficit.set(key, d);
  }
  if (deficit.size === 0) return { items: result, changed: false };

  const out: T[] = [];
  for (const line of result) {
    const key = ticketDraftLineKey(line);
    const d = deficit.get(key);
    if (!d || !isLive(line)) {
      out.push(line);
      continue;
    }
    let left = qtyOf(line);
    for (const flag of ['paid', 'voided'] as const) {
      const take = Math.min(left, d[flag]);
      if (take <= EPS) continue;
      out.push({ ...line, qty: roundQty(take), [flag]: true });
      d[flag] = roundQty(d[flag] - take);
      left = roundQty(left - take);
    }
    if (left > EPS) out.push({ ...line, qty: roundQty(left) });
  }
  return { items: out, changed: true };
}

/**
 * Undo voids in `result` that the bill does not record. Per item, at most
 * the bill's voided quantity stays voided; any more is live again.
 */
export function capVoidsToBill<T extends MergeLine>(
  result: T[],
  bill: readonly MergeLine[],
): { items: T[]; changed: boolean } {
  const allowed = new Map<string, number>();
  for (const line of bill) {
    if (line.voided !== true || line.paid === true) continue;
    const key = ticketDraftLineKey(line);
    allowed.set(key, (allowed.get(key) || 0) + qtyOf(line));
  }
  let changed = false;
  const out: T[] = [];
  for (const line of result) {
    if (line.voided !== true || line.paid === true) {
      out.push(line);
      continue;
    }
    const key = ticketDraftLineKey(line);
    const left = allowed.get(key) || 0;
    const qty = qtyOf(line);
    if (qty <= left + EPS) {
      allowed.set(key, roundQty(left - qty));
      out.push(line);
      continue;
    }
    changed = true;
    allowed.set(key, 0);
    if (left > EPS) out.push({ ...line, qty: roundQty(left) });
    out.push({ ...line, qty: roundQty(qty - left), voided: false });
  }
  return { items: changed ? out : result, changed };
}

/**
 * Add the lines a Send fired to `bill`. A held course line is already on
 * the bill unfired; firing it marks that line fired instead of adding a
 * second copy.
 */
function applyFiredDelta(bill: MergeLine[], added: MergeLine[]): MergeLine[] {
  const out = bill.map((l) => ({ ...l }));
  const extra: MergeLine[] = [];
  for (const line of added) {
    const key = ticketDraftLineKey(line);
    let left = qtyOf(line);
    for (let i = 0; i < out.length && left > EPS; i++) {
      const held = out[i];
      if (held.fired !== false || !isLive(held)) continue;
      if (ticketDraftLineKey(held) !== key) continue;
      const q = qtyOf(held);
      if (q <= left + EPS) {
        out[i] = { ...held, fired: true, sendKey: line.sendKey };
        left = roundQty(left - q);
      } else {
        out[i] = { ...held, qty: roundQty(q - left) };
        out.splice(i + 1, 0, {
          ...held,
          qty: roundQty(left),
          fired: true,
          sendKey: line.sendKey,
        });
        left = 0;
      }
    }
    if (left > EPS) extra.push({ ...line, qty: roundQty(left) });
  }
  return [...out, ...extra];
}

/**
 * The bill to write for one Send. `latest` is the newest bill of the
 * current sitting (empty when the sitting has none yet).
 */
export function mergeTicketSend<T extends MergeLine>(input: {
  incoming: T[];
  latest: readonly MergeLine[];
  /** The Send was built before `latest` was written. */
  stale: boolean;
  /** This Send's idempotency key, stamped on the lines it fired. */
  sendKey?: string | null;
  /** The lines this Send fired. Absent from older clients. */
  addedItems?: T[] | null;
}): { items: MergeLine[]; mode: TicketSendMergeMode } {
  // A line with no `fired` flag was written before courses existed: it is
  // on the bill like any fired line.
  const latest = ((input.latest || []) as MergeLine[]).map((l) =>
    l.fired === undefined ? { ...l, fired: true } : l,
  );
  const key = String(input.sendKey || '').trim();
  const added = Array.isArray(input.addedItems) ? input.addedItems : null;

  if (latest.length === 0) {
    const capped = capVoidsToBill(input.incoming, []);
    return {
      items: capped.items,
      mode: capped.changed ? 'restored' : 'as-sent',
    };
  }

  if (key && added && latest.some((l) => l.sendKey === key)) {
    return { items: latest, mode: 'already-included' };
  }

  if (input.stale && added) {
    return {
      items: applyFiredDelta(
        latest,
        added.map((l) => ({ ...l, sendKey: key || l.sendKey })),
      ),
      mode: 'stale-delta',
    };
  }

  // Lines this Send fired are new; only the rest can stand in for lines
  // already on the bill (see restoreMissingServerLines).
  const onBill = key
    ? input.incoming.filter((l) => l.sendKey !== key)
    : input.incoming;
  const restored = restoreMissingServerLines<MergeLine>(
    input.incoming,
    latest,
    onBill,
  );
  const capped = capVoidsToBill(restored, latest);
  const carried = carryVoidAndPaid(capped.items, latest);
  const changed =
    restored !== input.incoming || capped.changed || carried.changed;
  return { items: carried.items, mode: changed ? 'restored' : 'as-sent' };
}
