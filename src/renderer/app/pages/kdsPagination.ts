/**
 * Pure layout math for the KDS ticket board. Kept free of React/DOM so the
 * column-flow packing can be unit-tested in isolation.
 *
 * The board renders each page as a CSS multi-column flow (`column-fill: auto`)
 * with `break-inside: avoid` on every leaf block (ticket header, note, item
 * rows). A ticket can therefore start in one column and continue in the next.
 * We model each ticket as the ordered list of its leaf-block heights and
 * simulate that exact flow to decide how many tickets fit per page.
 */

export const TICKET_GAP_PX = 12;
export const COLUMN_GAP_PX = 12;

export function columnWidthForContainer(containerWidth: number): number {
  return Math.min(380, Math.max(280, containerWidth * 0.28));
}

export function maxColumnsForWidth(containerWidth: number): number {
  const colW = columnWidthForContainer(containerWidth);
  return Math.max(
    1,
    Math.floor((containerWidth + COLUMN_GAP_PX) / (colW + COLUMN_GAP_PX)),
  );
}

/**
 * Fold the card padding and the gap to the next card into the first/last leaf
 * block, so a ticket's block heights sum to the exact space it occupies.
 */
export function withCardChrome(leaves: number[]): number[] {
  if (leaves.length === 0) return [];
  const b = leaves.slice();
  b[0] += 12; // card top padding (p-3)
  b[b.length - 1] += 12 + TICKET_GAP_PX; // bottom padding + gap to next card
  return b;
}

/** Simulate placing one ticket's blocks into the column flow from (col, y). */
export function placeBlocks(
  blocks: number[],
  startCol: number,
  startY: number,
  colHeight: number,
): { col: number; y: number } {
  let col = startCol;
  let y = startY;
  for (const b of blocks) {
    // break-inside: avoid — a block that doesn't fit the remaining space moves
    // whole to the next column (matching the browser's column-fill: auto).
    if (y > 0 && y + b > colHeight) {
      col++;
      y = 0;
    }
    y += b;
  }
  return { col, y };
}

/**
 * Pack tickets into pages by simulating the column flow block-by-block. A page
 * is full once the flow would need more than `maxCols` columns — then the
 * ticket starts the next page. Because this mirrors the real layout, the final
 * column packs as tightly as the rest instead of leaving room for an unplaced
 * ticket.
 */
export function paginateTicketBlocks(
  ticketBlocks: number[][],
  maxCols: number,
  colHeight: number,
): number[][] {
  if (ticketBlocks.length === 0) return [];
  if (maxCols < 1 || colHeight <= 0) return [ticketBlocks.map((_, i) => i)];

  const pages: number[][] = [];
  let cur: number[] = [];
  let col = 0;
  let y = 0;

  for (let i = 0; i < ticketBlocks.length; i++) {
    const blocks = ticketBlocks[i];
    const res = placeBlocks(blocks, col, y, colHeight);
    if (res.col > maxCols - 1 && cur.length > 0) {
      // Doesn't fit on the current page — start a fresh one.
      pages.push(cur);
      cur = [i];
      const fresh = placeBlocks(blocks, 0, 0, colHeight);
      col = fresh.col;
      y = fresh.y;
    } else {
      cur.push(i);
      col = res.col;
      y = res.y;
    }
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

/** Open tickets one board asks the till for (the till caps a list at 1000). */
export const KDS_BOARD_LIMIT = 500;

/**
 * The board's tickets from a `listTickets({ withTotal: true })` answer, and
 * how many exist beyond them. A till too old for `withTotal` answers the
 * plain list: nothing is known to be missing then.
 */
export function kdsBoardRows<T>(res: unknown): { rows: T[]; notShown: number } {
  if (Array.isArray(res)) return { rows: res as T[], notShown: 0 };
  const r = (res || {}) as { rows?: unknown; total?: unknown; fetched?: unknown };
  const rows = Array.isArray(r.rows) ? (r.rows as T[]) : [];
  const total = Number(r.total);
  const fetched = Number(r.fetched);
  const shown = Number.isFinite(fetched) && fetched > 0 ? fetched : rows.length;
  return {
    rows,
    notShown: Number.isFinite(total) ? Math.max(0, total - shown) : 0,
  };
}
