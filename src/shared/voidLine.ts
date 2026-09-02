/**
 * Picking which line of a ticket snapshot a void applies to.
 *
 * The renderer identifies the line by its contents rather than by an id (the
 * snapshot in `TicketLog.itemsJson` has no stable per-line id). Matching on the
 * display name alone is not enough: a check routinely carries the same dish
 * twice at different prices ("Beer" at happy-hour and full price) or with
 * different notes ("Steak / rare" and "Steak / well done"), and voiding the
 * wrong one leaves the kitchen, the receipt and the reports disagreeing about
 * what the guest actually got.
 */

export interface VoidTargetLine {
  sku?: string | null;
  name?: string | null;
  note?: string | null;
  unitPrice?: number | null;
  qty?: number | null;
}

function sameText(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function samePrice(a: unknown, b: unknown): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  // Compare in cents so 3.0000000000000004 still matches 3.
  return Math.round(x * 100) === Math.round(y * 100);
}

function matchTiersFor(target: VoidTargetLine): ((line: any) => boolean)[] {
  const hasSku = String(target.sku ?? '').trim() !== '';
  const hasPrice = Number.isFinite(Number(target.unitPrice));

  const tiers: ((line: any) => boolean)[] = [];
  if (hasSku && hasPrice) {
    tiers.push(
      (line) =>
        sameText(line?.sku, target.sku) &&
        samePrice(line?.unitPrice, target.unitPrice) &&
        sameText(line?.note, target.note) &&
        samePrice(line?.qty ?? 1, target.qty ?? 1),
    );
    tiers.push(
      (line) =>
        sameText(line?.sku, target.sku) &&
        samePrice(line?.unitPrice, target.unitPrice) &&
        sameText(line?.note, target.note),
    );
  }
  if (hasPrice) {
    tiers.push(
      (line) =>
        sameText(line?.name, target.name) &&
        samePrice(line?.unitPrice, target.unitPrice) &&
        sameText(line?.note, target.note) &&
        samePrice(line?.qty ?? 1, target.qty ?? 1),
    );
    tiers.push(
      (line) =>
        sameText(line?.name, target.name) &&
        samePrice(line?.unitPrice, target.unitPrice) &&
        sameText(line?.note, target.note),
    );
    tiers.push(
      (line) =>
        sameText(line?.name, target.name) &&
        samePrice(line?.unitPrice, target.unitPrice),
    );
  }
  tiers.push(
    (line) =>
      sameText(line?.name, target.name) && sameText(line?.note, target.note),
  );
  tiers.push((line) => sameText(line?.name, target.name));
  return tiers;
}

export interface VoidLineMatch {
  /** Index into the supplied list, or -1 when nothing matched. */
  index: number;
  /**
   * How exact the match was; 0 is the most precise. Callers that search
   * several lists (the KDS routes one ticket's lines per station) compare
   * ranks so an exact hit in a later list beats a loose one in an earlier list.
   */
  rank: number;
}

const NO_MATCH: VoidLineMatch = { index: -1, rank: Number.POSITIVE_INFINITY };

/**
 * Locate the line a void applies to, progressively relaxing the comparison so
 * an older client that only sends a name still voids something while a client
 * that sends the whole line always hits the exact one. Already-voided lines are
 * never returned — voiding twice must not silently consume a second line.
 */
export function matchVoidableLine(
  items: readonly unknown[] | null | undefined,
  target: VoidTargetLine | null | undefined,
): VoidLineMatch {
  const list = Array.isArray(items) ? items : [];
  if (!target) return NO_MATCH;
  const tiers = matchTiersFor(target);
  for (let rank = 0; rank < tiers.length; rank++) {
    const matches = tiers[rank]!;
    const index = list.findIndex((line: any) => !line?.voided && matches(line));
    if (index !== -1) return { index, rank };
  }
  return NO_MATCH;
}

/** Index of the line to void, or -1 when the snapshot has no candidate. */
export function findVoidableLineIndex(
  items: readonly unknown[] | null | undefined,
  target: VoidTargetLine | null | undefined,
): number {
  return matchVoidableLine(items, target).index;
}
