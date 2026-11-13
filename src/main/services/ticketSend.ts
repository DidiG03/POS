/**
 * One Send, from the till (`tickets:log`) or a phone (`POST /tickets`).
 *
 * The two routes used to carry their own copy of this logic, and both wrote
 * the incoming snapshot as the bill. Everything that decides what lands on
 * the bill now happens here, under the table lock:
 *
 *   1. A Send already recorded (same idempotency key) is a no-op.
 *   2. An order taken before the table was last closed (paid, voided or
 *      moved away) is refused. The till used to reopen the table for it,
 *      which put a paid sitting's bill back on the floor to be charged again.
 *   3. The table is opened if needed, in the same lock as the write.
 *   4. Another waiter's sitting is refused unless the actor is an admin.
 *   5. The Send's new lines are added to the bill already there
 *      (see `mergeTicketSend`). A Send never changes a line the bill has,
 *      so a late or concurrent Send cannot drop items, undo a void, or
 *      charge a paid line again.
 *
 * Step 2 also drops lines from a sitting that has ended: a screen left on a
 * table that another device paid would otherwise start a new sitting with
 * the old, paid bill on it. The rest of that Send (the new order) goes
 * through, so a free table can always take an order.
 *
 * Every line is priced and named from the menu, unknown items are refused,
 * and the table must be on the floor plan; counted stock is taken in the
 * same transaction as the bill write.
 */
import { prisma } from '@db/client';
import { asTicketLogItems } from '@shared/ticketLogItems';
import { intentAtFromAge } from '@shared/tableIntent';
import {
  mergeTicketSend,
  type MergeLine,
  type TicketSendMergeMode,
} from '@shared/ticketMerge';
import { lineIdOf, newTicketLineId, withLineIds } from '@shared/ticketLineIds';
import { coreServices, withTableLock } from './core';
import { ensureOccupiedForTicketWrite } from './tableOpen';
import { occupancyIntentIsStale } from './tableOccupancy';
import {
  findLatestTicketLogForCurrentSession,
  getCurrentSessionOwnerId,
  getCurrentTableSessionKey,
} from './tableSession';
import { writeTicketSnapshot, type StockConsumeInput } from './ticketLogWrite';
import { OutOfStockError } from './menuStock';
import { repriceLinesFromMenu } from './linePricing';
import { checkFloorTable } from './floorTables';
import { logIgnored } from './logIgnored';

export type TicketSendInput = {
  userId: number;
  area: string;
  tableLabel: string;
  covers: number | null;
  items: unknown[];
  note: string | null;
  idempotencyKey?: string | null;
  stockConsumeLines?: StockConsumeInput[];
  /**
   * When the order was taken, on the till's clock (the phone sends its age;
   * see `resolveHostIntent`). Absent from older clients.
   */
  capturedAt?: number | null;
  /** The lines this Send fires. Absent from older clients. */
  addedItems?: unknown[] | null;
};

export type TicketSendResult =
  | { ok: true; written: false }
  | {
      ok: true;
      written: true;
      /**
       * The Send key on the lines this write fired: the caller's, or one the
       * till made up for a Send that came without one. A kitchen slip for
       * this Send prints these lines (`orderSlip.ts`).
       */
      sendKey: string;
      sessionKey: string | null;
      mode: TicketSendMergeMode;
      /**
       * Lines this write put on the bill for the first time (by Send key),
       * fired and live: what the kitchen has not seen yet. Null when the
       * Send carries no keys (older client); use its own fire list then.
       */
      firedNow: MergeLine[] | null;
    }
  | {
      ok: false;
      error: string;
      code:
        | 'TABLE_CLOSED'
        | 'TABLE_OWNED_BY_OTHER'
        | 'INVALID_ORDER'
        | 'UNKNOWN_TABLE'
        | 'OUT_OF_STOCK';
      ownerId?: number;
      ownerName?: string | null;
      /** OUT_OF_STOCK: the item and how many are left. */
      stock?: { sku: string; name: string; remaining: number };
    };

/**
 * Lines of `next` whose Send key is not on `previous`, fired and live.
 *
 * Kitchen cards and the stock count follow this, not the payload's own fire
 * list. A Send replayed after its rows were compacted away is no longer
 * caught by its idempotency key; counting its payload again sent the dish
 * to the kitchen twice. And a queued Send whose lines a later Send already
 * carried onto the bill still reaches the kitchen exactly once.
 */
export function linesNewToBill(
  next: MergeLine[],
  previous: MergeLine[],
): MergeLine[] | null {
  if (!next.some((l) => String(l.sendKey || '').trim())) return null;
  const seen = new Set(
    previous.map((l) => String(l.sendKey || '').trim()).filter(Boolean),
  );
  return next.filter((l) => {
    const key = String(l.sendKey || '').trim();
    return (
      key &&
      !seen.has(key) &&
      l.fired !== false &&
      l.voided !== true &&
      l.paid !== true
    );
  });
}

export const BILL_FROM_CLOSED_SITTING_MESSAGE =
  'This screen still shows a bill that was already closed (paid, voided or moved). Reopen the table to see its current bill.';

/**
 * Lines in `items` that belong to a different sitting than the current one,
 * by Send key or line id.
 *
 * A line's `sendKey` is the idempotency key of the Send that fired it, so
 * the TicketLog row with that key says which sitting it was on. Rows are
 * compacted to the newest few per sitting, though, so the key's own row can
 * be gone; the last bills of earlier sittings at this table still list every
 * line they had (`sendKey` and `lineId`). Keys and ids the till has never
 * seen (a Send still queued on the phone, or one that was refused) prove
 * nothing and are ignored.
 */
export async function closedSittingLines(input: {
  area: string;
  tableLabel: string;
  items: unknown[];
  ownKey: string;
  latestItems: MergeLine[];
  sessionKey: string | null;
}): Promise<{ sendKeys: Set<string>; lineIds: Set<string> }> {
  const none = { sendKeys: new Set<string>(), lineIds: new Set<string>() };
  const onBillKeys = new Set(
    input.latestItems.map((l) => String(l.sendKey || '')).filter(Boolean),
  );
  const onBillIds = new Set(input.latestItems.map(lineIdOf).filter(Boolean));
  const foreignKeys = new Set<string>();
  const foreignIds = new Set<string>();
  for (const raw of input.items) {
    const key = String((raw as MergeLine)?.sendKey || '').trim();
    if (key && key !== input.ownKey && !onBillKeys.has(key)) {
      foreignKeys.add(key);
    }
    const id = lineIdOf(raw);
    if (id && !onBillIds.has(id)) foreignIds.add(id);
  }
  if (foreignKeys.size === 0 && foreignIds.size === 0) return none;
  const otherSitting = (sessionKey: unknown) =>
    ((sessionKey as string | null | undefined) ?? null) !== input.sessionKey;

  const sendKeys = new Set<string>();
  const lineIds = new Set<string>();
  if (foreignKeys.size) {
    const rows = (await prisma.ticketLog
      .findMany({
        where: { idempotencyKey: { in: [...foreignKeys].slice(0, 50) } } as any,
        select: { sessionKey: true, idempotencyKey: true } as any,
      })
      .catch(logIgnored('ticketSend:182', []))) as Array<{
      sessionKey?: string | null;
      idempotencyKey?: string | null;
    }>;
    for (const r of rows) {
      const key = String(r.idempotencyKey || '');
      if (key && otherSitting(r.sessionKey)) sendKeys.add(key);
    }
  }
  const recent = (await prisma.ticketLog
    .findMany({
      where: { area: input.area, tableLabel: input.tableLabel },
      orderBy: { id: 'desc' },
      take: 40,
      select: { id: true, sessionKey: true, itemsJson: true } as any,
    } as any)
    .catch(logIgnored('ticketSend:198', []))) as Array<{
    id: number;
    sessionKey?: string | null;
    itemsJson?: unknown;
  }>;
  for (const row of recent) {
    if (!otherSitting(row.sessionKey)) continue;
    const lines = withLineIds(asTicketLogItems(row.itemsJson) as MergeLine[], {
      seed: row.id,
    });
    for (const l of lines) {
      const key = String(l.sendKey || '').trim();
      if (key && foreignKeys.has(key)) sendKeys.add(key);
      const id = lineIdOf(l);
      if (id && foreignIds.has(id)) lineIds.add(id);
    }
  }
  return { sendKeys, lineIds };
}

/**
 * The lines a Send adds itself: fired under its own key, or new held
 * course lines (no key, never on a bill). Null when the Send has no key,
 * so its new lines cannot be told from its copy of the bill.
 */
export function ownLinesOfSend(
  items: unknown,
  sendKey: string,
): unknown[] | null {
  const key = String(sendKey || '').trim();
  if (!key) return null;
  return (Array.isArray(items) ? items : []).filter((raw) => {
    const l = (raw || {}) as MergeLine;
    if (l.voided === true || l.paid === true) return false;
    const lineKey = String(l.sendKey || '').trim();
    if (lineKey) return lineKey === key;
    return l.fired === false && !lineIdOf(raw);
  });
}

export const ORDER_AFTER_CLOSE_MESSAGE =
  'This table was closed after the order was taken (paid, voided or moved). Open the table again and send the order again if it is still wanted.';

/**
 * When the order in this payload was taken, on the till's clock. Devices
 * send how long ago that was (`intentAgeMs`), never their own clock.
 */
export function ticketCapturedAt(
  payload: { intentAgeMs?: unknown } | null | undefined,
  now = Date.now(),
): number | null {
  const raw = payload?.intentAgeMs;
  if (raw == null || raw === '') return null;
  const age = Number(raw);
  if (!Number.isFinite(age) || age < 0) return null;
  return intentAtFromAge(age, now);
}

async function isAdminUser(userId: number): Promise<boolean> {
  const user = await prisma.user
    .findUnique({ where: { id: Number(userId) } })
    .catch(logIgnored('ticketSend:259', null));
  return Boolean(
    user && String((user as any).role || '').toUpperCase() === 'ADMIN',
  );
}

/** Largest quantity one line may carry (weighed items are fractions). */
export const MAX_LINE_QTY = 9999;
/** Largest unit price, in the venue's currency. */
export const MAX_UNIT_PRICE = 10_000_000;

// Control characters have no place in a label, and U+001F separates the
// parts of a sitting key.
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Check a Send's table and lines before anything is written. Returns the
 * lines with numeric fields as numbers and zero-quantity lines dropped, or
 * the reason the Send is refused.
 *
 * Without this a negative quantity put stock back and showed a negative
 * bill, and a price or quantity of "abc" or 1e12 was stored as sent.
 */
export function validateTicketSendLines(input: {
  area: unknown;
  tableLabel: unknown;
  items: unknown;
  /** The fired subset may be empty (a Send that only re-sends the bill). */
  allowEmpty?: boolean;
}):
  | { ok: true; items: Record<string, unknown>[] }
  | { ok: false; error: string } {
  const area = String(input.area ?? '').trim();
  const label = String(input.tableLabel ?? '').trim();
  if (!area || !label) return { ok: false, error: 'The table has no name.' };
  if (CONTROL_CHARS.test(area) || CONTROL_CHARS.test(label)) {
    return { ok: false, error: 'The table name has invalid characters.' };
  }
  if (!Array.isArray(input.items)) {
    return { ok: false, error: 'The order has no items.' };
  }
  const out: Record<string, unknown>[] = [];
  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'The order has an unreadable line.' };
    }
    const line = raw as Record<string, unknown>;
    const name =
      String(line.name ?? '').trim() || String(line.sku ?? '').trim();
    if (
      !name ||
      typeof line.name === 'object' ||
      typeof line.sku === 'object'
    ) {
      return { ok: false, error: 'An order line has no item name.' };
    }
    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || qty < 0 || qty > MAX_LINE_QTY) {
      return {
        ok: false,
        error: `${name}: quantity ${String(line.qty)} is not allowed.`,
      };
    }
    if (qty === 0) continue;
    let unitPrice = line.unitPrice;
    if (unitPrice !== undefined && unitPrice !== null) {
      const p = Number(unitPrice);
      if (!Number.isFinite(p) || p < 0 || p > MAX_UNIT_PRICE) {
        return {
          ok: false,
          error: `${name}: price ${String(unitPrice)} is not allowed.`,
        };
      }
      unitPrice = p;
    }
    out.push({
      ...line,
      qty,
      ...(unitPrice !== undefined ? { unitPrice } : {}),
    });
  }
  if (out.length === 0 && !input.allowEmpty) {
    return { ok: false, error: 'The order has no items.' };
  }
  return { ok: true, items: out };
}

/**
 * Price and name every line from this till's menu, by item code.
 *
 * Payments were already repriced (`linePricing.ts`), but the bill a Send
 * stored kept the device's own prices and names, so the pre-bill, the
 * kitchen and the waiter's screen showed a Ribeye at 0.01 or an item the
 * menu never had at 0. A price the item had since the table was seated is
 * kept (the guest was quoted it); anything else becomes the menu's.
 *
 * A line that is not on the menu at all is refused unless it is already on
 * this sitting's bill (an item removed from the menu mid-service).
 */
export async function priceSendLinesFromMenu(input: {
  area: string;
  tableLabel: string;
  items: Record<string, unknown>[];
  /** Send keys already on the current bill. */
  billKeys?: Set<string>;
}): Promise<
  { ok: true; items: Record<string, unknown>[] } | { ok: false; error: string }
> {
  const priced = await repriceLinesFromMenu({
    items: input.items,
    area: input.area,
    tableLabel: input.tableLabel,
  });
  // Menu unreadable: keep the lines, as the payment check does. The bill is
  // repriced again at payment.
  if (!priced) return { ok: true, items: input.items };
  const names = new Map<string, string>();
  const rows = (await prisma.menuItem
    .findMany({
      where: {
        sku: {
          in: [
            ...new Set(
              priced.items.map((l: any) => String(l?.sku || '').trim()),
            ),
          ].filter(Boolean),
        },
      },
      select: { sku: true, name: true },
    } as any)
    .catch(logIgnored('ticketSend:390', []))) as Array<{
    sku: string;
    name: string;
  }>;
  for (const r of rows) names.set(String(r.sku), String(r.name));
  const unknown = new Set(
    priced.issues
      .filter((i) => i.kind === 'unknown')
      .map((i) => `${i.sku}\u0000${i.name}`),
  );
  const out: Record<string, unknown>[] = [];
  for (const line of priced.items as Record<string, unknown>[]) {
    const sku = String(line.sku || '').trim();
    const name = String(line.name || '').trim();
    if (line.voided !== true && unknown.has(`${sku}\u0000${name}`)) {
      const onBill =
        input.billKeys && input.billKeys.has(String(line.sendKey || ''));
      if (!onBill) {
        return {
          ok: false,
          error: `${name || sku || 'An item'} is not on the menu. Refresh the menu and send again.`,
        };
      }
    }
    const menuName = names.get(sku);
    out.push(menuName ? { ...line, name: menuName } : line);
  }
  return { ok: true, items: out };
}

export async function recordTicketSend(
  rawInput: TicketSendInput,
): Promise<TicketSendResult> {
  const checked = validateTicketSendLines(rawInput);
  if (!checked.ok) {
    return { ok: false, error: checked.error, code: 'INVALID_ORDER' };
  }
  let addedItems = rawInput.addedItems;
  if (Array.isArray(addedItems)) {
    const added = validateTicketSendLines({
      ...rawInput,
      items: addedItems,
      allowEmpty: true,
    });
    if (!added.ok) {
      return { ok: false, error: added.error, code: 'INVALID_ORDER' };
    }
    addedItems = added.items;
  }
  const input: TicketSendInput = {
    ...rawInput,
    area: String(rawInput.area).trim(),
    tableLabel: String(rawInput.tableLabel).trim(),
    items: checked.items,
    addedItems,
  };
  const area = input.area;
  const tableLabel = input.tableLabel;
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  // When the order was taken. A Send that does not say (older clients,
  // scripts) counts from when it reached the till: it must not land on a
  // table that a payment closed while it was waiting for the table lock.
  const captured = Number(input.capturedAt);
  const capturedAt =
    Number.isFinite(captured) && captured > 0 ? captured : Date.now();

  return withTableLock(area, tableLabel, async () => {
    // 1. Inside the lock: two deliveries of one Send can arrive together.
    if (idempotencyKey) {
      const existing = await prisma.ticketLog
        .findFirst({ where: { idempotencyKey } as any })
        .catch(logIgnored('ticketSend:458', null));
      if (existing) return { ok: true as const, written: false as const };
    }

    // 1b. The table has to exist (see `floorTables.ts`).
    {
      const exists = await checkFloorTable(area, tableLabel);
      if (!exists.ok) {
        return {
          ok: false as const,
          error: exists.error,
          code: 'UNKNOWN_TABLE' as const,
        };
      }
    }

    // 2a. Lines from a sitting that has ended (a stale screen: the phone
    // still shows the previous party's bill). Those lines are dropped, not
    // sent: they were paid, voided or moved with that sitting. Refusing the
    // whole Send instead left the table unusable from that phone — every
    // new order carried the old lines and was refused again.
    let billBefore: unknown = null;
    let sessionKeyBefore: string | null = null;
    let sittingReadOk = true;
    {
      const current = await findLatestTicketLogForCurrentSession(
        area,
        tableLabel,
      ).catch(() => ((sittingReadOk = false), null));
      billBefore = current;
      const closed = await closedSittingLines({
        area,
        tableLabel,
        items: Array.isArray(input.items) ? input.items : [],
        ownKey: idempotencyKey,
        latestItems: current
          ? (asTicketLogItems((current as any).itemsJson) as MergeLine[])
          : [],
        sessionKey: (sessionKeyBefore = await getCurrentTableSessionKey(
          area,
          tableLabel,
        ).catch(() => ((sittingReadOk = false), null))),
      });
      if (closed.sendKeys.size || closed.lineIds.size) {
        const fromOpenSitting = (raw: unknown) =>
          !closed.sendKeys.has(
            String((raw as MergeLine)?.sendKey || '').trim(),
          ) && !closed.lineIds.has(lineIdOf(raw));
        input.items = (input.items as unknown[]).filter(fromOpenSitting);
        if (Array.isArray(input.addedItems)) {
          input.addedItems = input.addedItems.filter(fromOpenSitting);
        }
        console.warn(
          `[tickets] ${area} ${tableLabel}: dropped lines of a closed sitting`,
        );
        if (!input.items.length) {
          return {
            ok: false as const,
            error: BILL_FROM_CLOSED_SITTING_MESSAGE,
            code: 'TABLE_CLOSED' as const,
          };
        }
      }
    }

    // 2b. The table was closed or reopened after this order was taken, or
    // after it reached the till (a payment committed while it waited for
    // the lock). The phone's copy of the bill is then a copy of a bill that
    // was paid: only the lines this Send itself adds may go on, and they go
    // on a new bill. Anything else on it (the paid lines) would come back
    // unpaid and be charged again.
    if (await occupancyIntentIsStale(area, tableLabel, capturedAt)) {
      const own = ownLinesOfSend(input.items, idempotencyKey);
      const open = await coreServices.isTableOpen(area, tableLabel);
      if (own) {
        if (!own.length) {
          return {
            ok: false as const,
            error: ORDER_AFTER_CLOSE_MESSAGE,
            code: 'TABLE_CLOSED' as const,
          };
        }
        input.items = own;
        if (Array.isArray(input.addedItems)) {
          input.addedItems = ownLinesOfSend(
            input.addedItems,
            idempotencyKey,
          ) as unknown[];
        }
      } else if (!open) {
        // A Send without a key cannot tell its new lines from the old bill.
        return {
          ok: false as const,
          error: ORDER_AFTER_CLOSE_MESSAGE,
          code: 'TABLE_CLOSED' as const,
        };
      }
    }

    // 2c. This Send starts the sitting's bill (the table is free, or was
    // just opened and has no bill yet). A new bill has nothing to carry
    // over. Lines keyed to a closed sitting were dropped in 2a; a fired line
    // with no key at all cannot be from this Send (current clients key what
    // they fire) nor from one still queued on the phone (also keyed), so it
    // is a stale copy of a bill that was paid, voided or moved (older
    // bills, lines a phone restored from its cache). Putting it on the new
    // bill charged it twice (QA v0.2.103, H3). Only for a Send that marks
    // its own lines: an older client marks none and must still get through.
    const all = Array.isArray(input.items) ? input.items : [];
    const marksOwnLines = all.some(
      (l) => String((l as MergeLine)?.sendKey || '').trim() === idempotencyKey,
    );
    if (!billBefore && idempotencyKey && marksOwnLines) {
      const carried = (raw: unknown) => {
        const l = (raw || {}) as MergeLine;
        return !String(l.sendKey || '').trim() && l.fired !== false;
      };
      const kept = all.filter((l) => !carried(l));
      if (kept.length < all.length) {
        console.warn(
          `[tickets] ${area} ${tableLabel}: new bill drops ${all.length - kept.length} unkeyed line(s) carried from an earlier bill`,
        );
        input.items = kept;
      }
    }

    // 3.
    const openedNow = await ensureOccupiedForTicketWrite(area, tableLabel);
    // The table was already open and nothing was written since step 2a (we
    // hold the table lock): the sitting read there is still current, so it
    // is not read again (perf, QA v0.2.103: each read is several queries).
    const sameSitting = openedNow === false && sittingReadOk;

    // 4. Scoped to the current sitting: tables are reused, and the last
    // writer of a previous party must not block the next one.
    const ownerId = sameSitting
      ? billBefore
        ? Number((billBefore as any).userId)
        : null
      : await getCurrentSessionOwnerId(area, tableLabel);
    if (ownerId !== null && ownerId !== Number(input.userId)) {
      if (!(await isAdminUser(input.userId))) {
        const owner = await prisma.user
          .findUnique({ where: { id: ownerId } })
          .catch(logIgnored('ticketSend:602', null));
        const ownerName = (owner as any)?.displayName || null;
        return {
          ok: false as const,
          error: `Table is owned by ${ownerName || `waiter #${ownerId}`}`,
          code: 'TABLE_OWNED_BY_OTHER' as const,
          ownerId,
          ownerName,
        };
      }
    }

    // 5.
    const latest = sameSitting
      ? (billBefore as any)
      : await findLatestTicketLogForCurrentSession(area, tableLabel).catch(
          () => null,
        );
    const latestItems = latest
      ? (asTicketLogItems((latest as any).itemsJson) as MergeLine[])
      : [];
    // A Send without a key (older clients, scripts) gets one from the till,
    // so its lines are keyed, counted and printed like any other Send's.
    const sendKey = idempotencyKey || `srv-${newTicketLineId()}`;
    const merged: { items: MergeLine[]; mode: TicketSendMergeMode } =
      mergeTicketSend({
        incoming: (Array.isArray(input.items)
          ? input.items
          : []) as MergeLine[],
        latest: latestItems,
        sendKey,
        addedItems: Array.isArray(input.addedItems)
          ? (input.addedItems as MergeLine[])
          : null,
      });
    // Everything in this Send is already on the bill (a replay, or a later
    // Send carried it): nothing to write, cook or count.
    if (merged.mode === 'already-included') {
      return { ok: true as const, written: false as const };
    }
    // Prices and names from the menu, not the device (see above). Only the
    // lines this Send fires need the menu; lines already on the bill keep
    // what they were sold at.
    {
      const billKeys = new Set(
        latestItems.map((l) => String(l.sendKey || '').trim()).filter(Boolean),
      );
      const priced = await priceSendLinesFromMenu({
        area,
        tableLabel,
        items: merged.items as unknown as Record<string, unknown>[],
        billKeys,
      });
      if (!priced.ok) {
        return {
          ok: false as const,
          error: priced.error,
          code: 'INVALID_ORDER' as const,
        };
      }
      merged.items = priced.items as unknown as MergeLine[];
    }
    merged.items = withLineIds(merged.items);
    const firedNow = linesNewToBill(merged.items, latestItems);

    const sessionKey = sameSitting
      ? sessionKeyBefore
      : await getCurrentTableSessionKey(area, tableLabel).catch(
          logIgnored('ticketSend:669', null),
        );
    let outcome: 'written' | 'duplicate';
    try {
      outcome = await writeTicketSnapshot({
        userId: Number(input.userId),
        area,
        tableLabel,
        // A Send without a guest count keeps the sitting's.
        covers: input.covers ?? (latest as any)?.covers ?? null,
        items: merged.items,
        note: input.note,
        idempotencyKey: sendKey,
        sessionKey,
        stockConsumeLines: firedNow
          ? firedNow.map((l) => ({ sku: l.sku, qty: Number(l.qty) }))
          : (input.stockConsumeLines ?? []),
      });
    } catch (e) {
      // Nothing was written: the stock check shares the bill's transaction.
      if (e instanceof OutOfStockError) {
        return {
          ok: false as const,
          error: e.message,
          code: 'OUT_OF_STOCK' as const,
          stock: { ...e.item, remaining: e.remaining },
        };
      }
      throw e;
    }
    if (outcome === 'duplicate') {
      return { ok: true as const, written: false as const };
    }
    return {
      ok: true as const,
      written: true as const,
      sendKey,
      sessionKey,
      mode: merged.mode,
      firedNow,
    };
  });
}
