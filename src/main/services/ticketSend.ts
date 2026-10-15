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
 *   5. The Send is merged with the bill already there
 *      (see `mergeTicketSend`), so a late or concurrent Send cannot drop
 *      items, undo a void, or charge a paid line again.
 *
 * Step 2 also refuses a Send carrying lines from a sitting that has ended:
 * a screen left on a table that another device paid would otherwise start
 * a new sitting with the old, paid bill on it.
 */
import { prisma } from '@db/client';
import { asTicketLogItems, ticketLogCreatedAtMs } from '@shared/ticketLogItems';
import { intentAtFromAge } from '@shared/tableIntent';
import {
  mergeTicketSend,
  type MergeLine,
  type TicketSendMergeMode,
} from '@shared/ticketMerge';
import { coreServices, withTableLock } from './core';
import { ensureOccupiedForTicketWrite } from './tableOpen';
import { occupancyIntentIsStale } from './tableOccupancy';
import {
  findLatestTicketLogForCurrentSession,
  getCurrentSessionOwnerId,
  getCurrentTableSessionKey,
} from './tableSession';
import { writeTicketSnapshot, type StockConsumeInput } from './ticketLogWrite';

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
      code: 'TABLE_CLOSED' | 'TABLE_OWNED_BY_OTHER' | 'INVALID_ORDER';
      ownerId?: number;
      ownerName?: string | null;
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
 * True when `items` carry lines fired by an earlier Send that belongs to a
 * different sitting than the current one. A line's `sendKey` is the
 * idempotency key of the Send that fired it, so the TicketLog row with that
 * key says which sitting it was on. Keys the till has never seen (a Send
 * still queued on the phone) prove nothing and are ignored.
 */
async function carriesClosedSittingLines(input: {
  items: unknown[];
  ownKey: string;
  latestItems: MergeLine[];
  sessionKey: string | null;
}): Promise<boolean> {
  const onBill = new Set(
    input.latestItems.map((l) => String(l.sendKey || '')).filter(Boolean),
  );
  const foreign = new Set<string>();
  for (const raw of input.items) {
    const key = String((raw as MergeLine)?.sendKey || '').trim();
    if (key && key !== input.ownKey && !onBill.has(key)) foreign.add(key);
  }
  if (foreign.size === 0) return false;
  const rows = (await prisma.ticketLog
    .findMany({
      where: { idempotencyKey: { in: [...foreign].slice(0, 50) } } as any,
      select: { sessionKey: true } as any,
    })
    .catch(() => [])) as Array<{ sessionKey?: string | null }>;
  return rows.some((r) => (r.sessionKey ?? null) !== input.sessionKey);
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
    .catch(() => null);
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
  const capturedAt = Number(input.capturedAt);
  const hasCapture = Number.isFinite(capturedAt) && capturedAt > 0;

  return withTableLock(area, tableLabel, async () => {
    // 1. Inside the lock: two deliveries of one Send can arrive together.
    if (idempotencyKey) {
      const existing = await prisma.ticketLog
        .findFirst({ where: { idempotencyKey } as any })
        .catch(() => null);
      if (existing) return { ok: true as const, written: false as const };
    }

    // 2a. Lines from a sitting that has ended (a stale screen).
    {
      const current = await findLatestTicketLogForCurrentSession(
        area,
        tableLabel,
      ).catch(() => null);
      if (
        await carriesClosedSittingLines({
          items: Array.isArray(input.items) ? input.items : [],
          ownKey: idempotencyKey,
          latestItems: current
            ? (asTicketLogItems((current as any).itemsJson) as MergeLine[])
            : [],
          sessionKey: await getCurrentTableSessionKey(area, tableLabel).catch(
            () => null,
          ),
        })
      ) {
        return {
          ok: false as const,
          error: BILL_FROM_CLOSED_SITTING_MESSAGE,
          code: 'TABLE_CLOSED' as const,
        };
      }
    }

    // 2b. The table was closed after this order was taken.
    if (hasCapture) {
      const open = await coreServices.isTableOpen(area, tableLabel);
      if (
        !open &&
        (await occupancyIntentIsStale(area, tableLabel, capturedAt))
      ) {
        return {
          ok: false as const,
          error: ORDER_AFTER_CLOSE_MESSAGE,
          code: 'TABLE_CLOSED' as const,
        };
      }
    }

    // 3.
    await ensureOccupiedForTicketWrite(area, tableLabel);

    // 4. Scoped to the current sitting: tables are reused, and the last
    // writer of a previous party must not block the next one.
    const ownerId = await getCurrentSessionOwnerId(area, tableLabel);
    if (ownerId !== null && ownerId !== Number(input.userId)) {
      if (!(await isAdminUser(input.userId))) {
        const owner = await prisma.user
          .findUnique({ where: { id: ownerId } })
          .catch(() => null);
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
    const latest = await findLatestTicketLogForCurrentSession(
      area,
      tableLabel,
    ).catch(() => null);
    const latestItems = latest
      ? (asTicketLogItems((latest as any).itemsJson) as MergeLine[])
      : [];
    const latestAt = latest
      ? ticketLogCreatedAtMs((latest as any).createdAt)
      : Number.NaN;
    const stale =
      hasCapture && Number.isFinite(latestAt) && latestAt > capturedAt;
    const merged = mergeTicketSend({
      incoming: (Array.isArray(input.items) ? input.items : []) as MergeLine[],
      latest: latestItems,
      stale,
      sendKey: idempotencyKey || null,
      addedItems: Array.isArray(input.addedItems)
        ? (input.addedItems as MergeLine[])
        : null,
    });
    if (merged.mode !== 'as-sent') {
      console.warn(
        `[tickets] ${area} ${tableLabel}: Send merged with the bill (${merged.mode})`,
      );
    }
    // Everything in this Send is already on the bill (a replay, or a later
    // Send carried it): nothing to write, cook or count.
    if (merged.mode === 'already-included') {
      return { ok: true as const, written: false as const };
    }
    const firedNow = linesNewToBill(merged.items, latestItems);

    const sessionKey = await getCurrentTableSessionKey(area, tableLabel).catch(
      () => null,
    );
    const outcome = await writeTicketSnapshot({
      userId: Number(input.userId),
      area,
      tableLabel,
      covers: input.covers,
      items: merged.items,
      note: input.note,
      idempotencyKey,
      sessionKey,
      stockConsumeLines: firedNow
        ? firedNow.map((l) => ({ sku: l.sku, qty: Number(l.qty) }))
        : (input.stockConsumeLines ?? []),
    });
    if (outcome === 'duplicate') {
      return { ok: true as const, written: false as const };
    }
    return {
      ok: true as const,
      written: true as const,
      sessionKey,
      mode: merged.mode,
      firedNow,
    };
  });
}
