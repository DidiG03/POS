/**
 * Revenue helpers: TicketLog rows store line items in `itemsJson`; voided lines
 * stay on the row with `voided: true` and must be excluded from net/VAT sums
 * everywhere we treat a row as revenue (same rule as admin analytics).
 */

export function liveTicketLines(itemsJson: unknown): any[] {
  const arr = Array.isArray(itemsJson) ? itemsJson : [];
  return arr.filter((it: any) => !it?.voided);
}

/** Shape of the TicketLog columns the session collapse needs. */
export interface TicketSnapshotRow {
  area?: string | null;
  tableLabel?: string | null;
  sessionKey?: string | null;
  createdAt?: Date | string | number | null;
  itemsJson?: unknown;
}

function rowTimeMs(row: TicketSnapshotRow): number {
  const raw = row?.createdAt;
  if (raw == null) return 0;
  const t =
    raw instanceof Date ? raw.getTime() : new Date(raw as any).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Identity of a line ignoring quantity and void state — those change in place. */
function lineIdentity(line: any): string {
  return [
    String(line?.sku ?? ''),
    String(line?.name ?? ''),
    String(line?.note ?? ''),
    String(line?.unitPrice ?? ''),
  ].join('\u0000');
}

/**
 * True when `next` looks like a later snapshot of the same dining session as
 * `prev`: every line of `prev` is still present, in order, at the head of
 * `next`. Sending an order appends the new lines to the ticket and re-sends the
 * whole thing, so that prefix relation holds for the life of a session and
 * breaks the moment the table is re-seated with a fresh ticket.
 */
function extendsSnapshot(prev: unknown, next: unknown): boolean {
  const a = Array.isArray(prev) ? prev : [];
  const b = Array.isArray(next) ? next : [];
  if (b.length < a.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (lineIdentity(a[i]) !== lineIdentity(b[i])) return false;
  }
  return true;
}

/**
 * Collapse cumulative TicketLog snapshots down to one row per dining session.
 *
 * Every "send to kitchen" writes a full snapshot of the ticket, not just the
 * newly fired lines (the kitchen gets the delta via `kdsFireItems`). Summing
 * every row therefore counts a table that was fired three times three times
 * over, and a line voided later still counts on the earlier snapshots that
 * were never patched. Reports have to look at the newest snapshot of each
 * session and nothing else.
 *
 * Rows written since `sessionKey` was introduced group exactly. Older rows have
 * no key, so they fall back to the append-only prefix relation described on
 * {@link extendsSnapshot}, which reconstructs the same grouping from the item
 * lists themselves.
 */
export function latestRowPerSession<T extends TicketSnapshotRow>(
  rows: readonly T[],
): T[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rowTimeMs(a.row) - rowTimeMs(b.row) || a.index - b.index);

  // Each slot holds the newest snapshot seen so far for one session. Slots keep
  // the input position of their first row so the result preserves caller order.
  type Slot = { row: T; index: number };
  const slots: Slot[] = [];
  const keyed = new Map<string, Slot>();
  const perTable = new Map<string, Slot>();

  for (const { row, index } of ordered) {
    const sessionKey = String(row?.sessionKey ?? '').trim();
    if (sessionKey) {
      const slot = keyed.get(sessionKey);
      if (slot) {
        slot.row = row;
        continue;
      }
      const fresh: Slot = { row, index };
      keyed.set(sessionKey, fresh);
      slots.push(fresh);
      continue;
    }

    const tableKey = `${String(row?.area ?? '')}\u0000${String(
      row?.tableLabel ?? '',
    )}`;
    const slot = perTable.get(tableKey);
    if (slot && extendsSnapshot(slot.row?.itemsJson, row?.itemsJson)) {
      slot.row = row;
      continue;
    }
    const fresh: Slot = { row, index };
    perTable.set(tableKey, fresh);
    slots.push(fresh);
  }

  return slots.sort((a, b) => a.index - b.index).map((slot) => slot.row);
}

/**
 * Resolve the VAT rate to apply to a line. A line that carries no rate
 * (or a 0 rate from legacy/cloud-synced data) falls back to the business
 * default (Albanian standard 20% → 0.2) so fiscalized receipts never
 * silently report 0% VAT. Pass `defaultRate = 0` to opt out of the
 * fallback (e.g. genuinely VAT-exempt contexts).
 */
export function effectiveVatRate(
  rawRate: unknown,
  defaultRate: unknown = 0,
): number {
  const r = Number(rawRate);
  if (Number.isFinite(r) && r > 0) return r;
  const d = Number(defaultRate);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Albanian fiscalization (and consumer-price law) treats displayed
 * prices as VAT-INCLUSIVE: the gross already contains the tax. This
 * extracts the contained VAT rather than adding it on top — so the
 * customer total stays equal to the menu price and matches the amount
 * sent to the fiscal provider (easyPos), which performs the same
 * inclusive extraction from `price`.
 *
 *   net = gross / (1 + rate)
 *   vat = gross − net
 */
export function splitGrossVat(
  gross: number,
  rate: number,
): { net: number; vat: number } {
  const g = Number(gross);
  if (!Number.isFinite(g) || g === 0) return { net: 0, vat: 0 };
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return { net: g, vat: 0 };
  const net = g / (1 + r);
  return { net, vat: g - net };
}

export function sumTicketLinesNetVat(
  itemsJson: unknown,
  vatEnabled = true,
  defaultVatRate = 0,
): {
  net: number;
  vat: number;
} {
  const lines = liveTicketLines(itemsJson);
  let net = 0;
  let vat = 0;
  for (const it of lines) {
    const qty = Number((it as any)?.qty || 1);
    const unit = Number((it as any)?.unitPrice || 0);
    const gross = unit * qty;
    if (!vatEnabled) {
      net += gross;
      continue;
    }
    const rate = effectiveVatRate((it as any)?.vatRate, defaultVatRate);
    const split = splitGrossVat(gross, rate);
    net += split.net;
    vat += split.vat;
  }
  return { net, vat };
}
