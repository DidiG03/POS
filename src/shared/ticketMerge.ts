/**
 * How the till applies one Send to the bill it already holds.
 *
 * The bill on the till is the record. A Send can only add to it: new lines
 * it fires, and course lines it holds for later. Everything else in the
 * Send's copy of the bill is ignored.
 *
 * The till used to reconcile the Send's whole snapshot with the bill, item
 * by item: lines the Send "accounted for" stood in for bill lines, and
 * voids and payments were carried across onto matching lines. Matching by
 * item is what broke. A phone that sent only its new Espresso had it folded
 * into the voided one (printed and taken off stock, never billed), and a
 * Send that raced a payment wrote the paid lines back as unpaid.
 *
 * Rules, against the latest bill of the current sitting:
 *   - Lines leave the bill, or change state, only through their own route
 *     (void, payment, transfer). A Send never voids, pays or un-pays.
 *   - A line naming a bill line (its `lineId`, or the `sendKey` of the Send
 *     that put it there) is that line, whatever the Send says about it.
 *   - The lines a Send fires are new lines, appended with its Send key:
 *     `addedItems` when the device lists them, else every fired, live line
 *     that names nothing on the bill. They are never matched to bill lines
 *     of the same item.
 *   - Firing a held course line marks that line fired (by `lineId`, or the
 *     same item among the held lines) instead of adding a second copy.
 *   - Held lines the bill does not have yet are added, still held.
 *   - A Send whose key is already on the bill was carried by an earlier
 *     write: nothing is added again.
 */
import { lineIdOf } from './ticketLineIds';
import { ticketDraftLineKey, type TicketDraftLine } from './ticketDraft';

export type MergeLine = TicketDraftLine & {
  sendKey?: string;
  [extra: string]: unknown;
};

export type TicketSendMergeMode =
  /** First write of the sitting. */
  | 'as-sent'
  /** New lines appended to the bill. */
  | 'appended'
  /** This Send is already on the bill, or adds nothing: nothing to write. */
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
 * Add the lines a Send fired to `bill`. A held course line is already on
 * the bill unfired; firing it marks that line fired instead of adding a
 * second copy.
 */
function applyFiredDelta(bill: MergeLine[], added: MergeLine[]): MergeLine[] {
  const out = bill.map((l) => ({ ...l }));
  const extra: MergeLine[] = [];
  for (const line of added) {
    const id = lineIdOf(line);
    const byId = id ? out.findIndex((l) => lineIdOf(l) === id) : -1;
    if (byId >= 0) {
      // The device names the held line it fires. Any other line with this
      // id is already sent: never added twice, never changed.
      const held = out[byId];
      if (held.fired === false && isLive(held)) {
        out[byId] = { ...held, fired: true, sendKey: line.sendKey };
      }
      continue;
    }
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
 * The lines one Send fires: new orders, stamped with `sendKey`.
 */
export function firedLinesOfSend<T extends MergeLine>(input: {
  incoming: readonly T[];
  latest: readonly MergeLine[];
  sendKey: string;
  /** The lines the device says this Send fires. Absent from older clients. */
  addedItems?: readonly T[] | null;
}): MergeLine[] {
  const key = input.sendKey;
  const billKeys = new Set(
    input.latest.map((l) => String(l.sendKey || '').trim()).filter(Boolean),
  );
  const fired = (l: MergeLine) => isLive(l) && l.fired !== false;
  if (Array.isArray(input.addedItems)) {
    return input.addedItems
      .filter((l) => l && fired(l))
      .map((l) => ({ ...l, fired: true, sendKey: key }));
  }
  // No list: every fired line that names nothing on the bill is new. Lines
  // the bill already has (by id, or by the Send that put them there) are
  // the device's copy of the bill.
  const billIds = new Set(input.latest.map(lineIdOf).filter(Boolean));
  const out: MergeLine[] = [];
  for (const line of input.incoming) {
    if (!line || !fired(line)) continue;
    const lineKey = String(line.sendKey || '').trim();
    if (lineKey !== key) {
      if (billIds.has(lineIdOf(line))) continue;
      if (lineKey && billKeys.has(lineKey)) continue;
    }
    const fresh: MergeLine = { ...line, fired: true, sendKey: key };
    // The till numbers new lines itself.
    if (lineKey !== key) delete fresh.lineId;
    out.push(fresh);
  }
  return out;
}

/**
 * Held (not yet fired) course lines of the Send that the bill does not have.
 * Compared only with the bill's own held lines: a held line is never matched
 * to a sent, voided or paid one.
 */
function newHeldLines(
  incoming: readonly MergeLine[],
  latest: readonly MergeLine[],
  firedIds: Set<string>,
): MergeLine[] {
  const billIds = new Set(latest.map(lineIdOf).filter(Boolean));
  const billKeys = new Set(
    latest.map((l) => String(l.sendKey || '').trim()).filter(Boolean),
  );
  const pool = new Map<string, number>();
  for (const line of latest) {
    if (line.fired !== false || !isLive(line)) continue;
    const k = ticketDraftLineKey(line);
    pool.set(k, roundQty((pool.get(k) || 0) + qtyOf(line)));
  }
  const out: MergeLine[] = [];
  for (const line of incoming) {
    if (!line || line.fired !== false || !isLive(line)) continue;
    const id = lineIdOf(line);
    if (id && (billIds.has(id) || firedIds.has(id))) continue;
    const lineKey = String(line.sendKey || '').trim();
    if (lineKey && billKeys.has(lineKey)) continue;
    const k = ticketDraftLineKey(line);
    const onBill = pool.get(k) || 0;
    const qty = qtyOf(line);
    const take = Math.min(qty, onBill);
    if (take > EPS) pool.set(k, roundQty(onBill - take));
    const left = roundQty(qty - take);
    if (left <= EPS) continue;
    const held: MergeLine = { ...line, qty: left, fired: false };
    delete held.sendKey;
    out.push(held);
  }
  return out;
}

/**
 * The bill to write for one Send. `latest` is the newest bill of the
 * current sitting (empty when the sitting has none yet).
 */
export function mergeTicketSend<T extends MergeLine>(input: {
  incoming: T[];
  latest: readonly MergeLine[];
  /** This Send's key, stamped on the lines it fires. */
  sendKey: string;
  /** The lines this Send fired. Absent from older clients. */
  addedItems?: T[] | null;
}): { items: MergeLine[]; mode: TicketSendMergeMode } {
  // A line with no `fired` flag was written before courses existed: it is
  // on the bill like any fired line.
  const latest = ((input.latest || []) as MergeLine[]).map((l) =>
    l.fired === undefined ? { ...l, fired: true } : l,
  );
  const key = String(input.sendKey || '').trim();
  if (key && latest.some((l) => l.sendKey === key)) {
    return { items: latest, mode: 'already-included' };
  }
  const fired = firedLinesOfSend({
    incoming: input.incoming || [],
    latest,
    sendKey: key,
    addedItems: input.addedItems,
  });
  const firedIds = new Set(fired.map(lineIdOf).filter(Boolean));
  const held = newHeldLines(input.incoming || [], latest, firedIds);
  if (!fired.length && !held.length) {
    return { items: latest, mode: 'already-included' };
  }
  return {
    items: [...applyFiredDelta(latest, fired), ...held],
    mode: latest.length ? 'appended' : 'as-sent',
  };
}
