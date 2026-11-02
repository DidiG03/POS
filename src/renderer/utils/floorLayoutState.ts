/** `null` means the area layout is still loading. `[]` is a saved empty area. */
export function isFloorLayoutPending(
  nodes: readonly unknown[] | null,
): boolean {
  return nodes == null;
}

export function isFloorLayoutVacant(nodes: readonly unknown[] | null): boolean {
  return Array.isArray(nodes) && nodes.length === 0;
}

/**
 * Auto-fit needs a real canvas box. `{w:0,h:0}` is the first React render
 * before the wrapper is measured — painting tables then would show them
 * clustered at saved coordinates, then spread when the scale lands.
 */
export function isFloorCanvasFitReady(size: { w: number; h: number }): boolean {
  return size.w > 0 && size.h > 0;
}

export type FloorViewTransform = {
  scale: number;
  scaleX: number;
  scaleY: number;
  tx: number;
  ty: number;
};

export const FLOOR_VIEW_IDENTITY: FloorViewTransform = {
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  tx: 0,
  ty: 0,
};

type FloorFitNode = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  kind?: string;
};

/** Uniform inset, or separate X/Y (waiter chips + dock need more vertical inset). */
export type FloorFitPadding = number | { x?: number; y?: number };

export function resolveFloorFitPadding(pad?: FloorFitPadding): {
  x: number;
  y: number;
} {
  if (pad == null) return { x: 12, y: 12 };
  if (typeof pad === 'number') {
    const n = Number.isFinite(pad) ? Math.max(0, pad) : 12;
    return { x: n, y: n };
  }
  const x = Number.isFinite(Number(pad.x)) ? Math.max(0, Number(pad.x)) : 12;
  const y = Number.isFinite(Number(pad.y)) ? Math.max(0, Number(pad.y)) : 12;
  return { x, y };
}

/** Largest on-screen size (px) auto-fit may give a table. */
export const MAX_FIT_TABLE_PX = 180;

/**
 * Uniform contain-fit for the waiter/host floor. Preserves the layout's
 * aspect ratio so a plan designed on Admin does not stretch sideways on
 * wide desktops. On narrow (phone) canvases we prefer filling the width
 * so tables are not tiny with empty bands on the sides.
 */
/** Room around a table for its card's shadow and status badges. */
export const TABLE_CHROME_PX = 10;

export function computeFloorViewTransform(args: {
  canvasW: number;
  canvasH: number;
  nodes: readonly FloorFitNode[];
  fitPadding?: FloorFitPadding;
}): FloorViewTransform {
  const cw = Math.max(0, args.canvasW);
  const ch = Math.max(0, args.canvasH);
  if (!isFloorCanvasFitReady({ w: cw, h: ch }) || !args.nodes.length) {
    return FLOOR_VIEW_IDENTITY;
  }
  const { x: padX, y: padY } = resolveFloorFitPadding(args.fitPadding);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let largestTable = 0;
  for (const n of args.nodes) {
    if (!n) continue;
    // Both tables and areas use translate(-50%, -50%), so x/y is the
    // centre of the node — measure half-extents on each axis.
    const x = Number(n.x || 0);
    const y = Number(n.y || 0);
    const isArea = String(n.kind || 'TABLE') === 'AREA';
    // A table's card is drawn with a shadow and status badges past its
    // own box; edge tables lost them to the canvas edge.
    const halfW = isArea
      ? Math.max(0, Number(n.w || 0)) / 2
      : Math.max(32, Number(n.w || 64) / 2) + TABLE_CHROME_PX;
    const halfH = isArea
      ? Math.max(0, Number(n.h || 0)) / 2
      : Math.max(32, Number(n.h || 64) / 2) + TABLE_CHROME_PX;
    if (!isArea) largestTable = Math.max(largestTable, halfW * 2, halfH * 2);
    minX = Math.min(minX, x - halfW);
    minY = Math.min(minY, y - halfH);
    maxX = Math.max(maxX, x + halfW);
    maxY = Math.max(maxY, y + halfH);
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return FLOOR_VIEW_IDENTITY;
  }

  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const availW = Math.max(1, cw - padX * 2);
  const availH = Math.max(1, ch - padY * 2);
  const scaleW = availW / bw;
  const scaleH = availH / bh;
  const minScale = 0.3;
  // Phones need room to grow — the old 2.4 cap left dense plans tiny.
  const maxScale = 5;
  const clamp = (raw: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, raw));

  // Every table on screen. Phones used to fill the width and accept up to
  // 45 % vertical overflow, "pinch-pan covers the rest" — but panning only
  // works once zoomed in, so tables at the top and bottom edges were cut
  // off and could not be reached (QA v0.2.103). A plan that fits still
  // fills the width; pinch-zoom is there for a closer look.
  let fit = Math.min(scaleW, scaleH);
  // A floor with one or two tables fit-to-screen blew a single table up
  // to fill the whole view. No table grows past a large touch target.
  const tableCap =
    largestTable > 0 ? MAX_FIT_TABLE_PX / largestTable : maxScale;
  fit = clamp(fit, minScale, Math.max(minScale, Math.min(maxScale, tableCap)));

  return {
    scale: fit,
    scaleX: fit,
    scaleY: fit,
    tx: (cw - bw * fit) / 2 - minX * fit,
    ty: (ch - bh * fit) / 2 - minY * fit,
  };
}

/** Seats left unset is fine (older layouts); an explicit 0 or less is not. */
export function seatsInvalid(seats: unknown): boolean {
  if (seats == null) return false;
  const n = Number(seats);
  return !Number.isFinite(n) || n < 1;
}
