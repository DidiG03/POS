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

/**
 * Uniform contain-fit for the waiter/host floor. Preserves the layout's
 * aspect ratio so a plan designed on Admin (or looking right on phones)
 * does not stretch sideways on wide desktop canvases. Letterboxing is
 * intentional — non-uniform stretch used to inflate horizontal gaps.
 */
export function computeFloorViewTransform(args: {
  canvasW: number;
  canvasH: number;
  nodes: readonly FloorFitNode[];
  fitPadding?: number;
}): FloorViewTransform {
  const cw = Math.max(0, args.canvasW);
  const ch = Math.max(0, args.canvasH);
  if (!isFloorCanvasFitReady({ w: cw, h: ch }) || !args.nodes.length) {
    return FLOOR_VIEW_IDENTITY;
  }
  const pad = Number.isFinite(Number(args.fitPadding))
    ? Math.max(0, Number(args.fitPadding))
    : 12;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of args.nodes) {
    if (!n) continue;
    // Both tables and areas use translate(-50%, -50%), so x/y is the
    // centre of the node — measure half-extents on each axis.
    const x = Number(n.x || 0);
    const y = Number(n.y || 0);
    const isArea = String(n.kind || 'TABLE') === 'AREA';
    const halfW = isArea
      ? Math.max(0, Number(n.w || 0)) / 2
      : Math.max(32, Number(n.w || 64) / 2);
    const halfH = isArea
      ? Math.max(0, Number(n.h || 0)) / 2
      : Math.max(32, Number(n.h || 64) / 2);
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
  const minScale = 0.3;
  const maxScale = 2.4;
  const clamp = (raw: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, raw));
  const fit = clamp(
    Math.min((cw - pad * 2) / bw, (ch - pad * 2) / bh),
    minScale,
    maxScale,
  );
  return {
    scale: fit,
    scaleX: fit,
    scaleY: fit,
    tx: (cw - bw * fit) / 2 - minX * fit,
    ty: (ch - bh * fit) / 2 - minY * fit,
  };
}
