/**
 * Block grid for the admin floor-layout editor.
 *
 * Nodes store a centre point `(x, y)`. Snapping aligns the bounding-box
 * top-left to a grid line so table edges line up, then writes the centre
 * back. The dining-room rectangle is editor chrome (not saved) so admins
 * have a starting point that matches how waiters see the floor.
 */

export const FLOOR_GRID = 16;
export const FLOOR_ROOM_W = 960;
export const FLOOR_ROOM_H = 640;

export function snapGrid(n: number, grid = FLOOR_GRID): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / grid) * grid;
}

export function snapSize(n: number, grid = FLOOR_GRID, min = grid): number {
  return Math.max(min, snapGrid(n, grid));
}

/** Snap so the box top-left sits on a grid intersection. `x,y` are centres. */
export function snapCenter(
  x: number,
  y: number,
  w: number,
  h: number,
  grid = FLOOR_GRID,
): { x: number; y: number } {
  const ww = Math.max(1, Number(w) || 1);
  const hh = Math.max(1, Number(h) || 1);
  const left = snapGrid(x - ww / 2, grid);
  const top = snapGrid(y - hh / 2, grid);
  return { x: left + ww / 2, y: top + hh / 2 };
}

export function floorNodeBox(n: { w?: number; h?: number; kind?: string }): {
  w: number;
  h: number;
} {
  const isArea = n.kind === 'AREA';
  const w = isArea
    ? Math.max(8, Number(n.w || 220))
    : Math.max(32, Number(n.w || 64));
  const h = isArea
    ? Math.max(8, Number(n.h || 140))
    : Math.max(32, Number(n.h || 64));
  return { w, h };
}

export function snapNodeCenter(n: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  kind?: string;
}): { x: number; y: number } {
  const { w, h } = floorNodeBox(n);
  return snapCenter(n.x, n.y, w, h);
}

/**
 * Place the next piece on a regular block row inside the dining room,
 * with a one-cell gutter so neighbours line up without overlapping.
 */
export function packOnGrid(
  index: number,
  w: number,
  h: number,
  roomW = FLOOR_ROOM_W,
  grid = FLOOR_GRID,
): { x: number; y: number } {
  const cellW = snapSize(w, grid) + grid;
  const cellH = snapSize(h, grid) + grid;
  const cols = Math.max(1, Math.floor((roomW - grid) / cellW));
  const col = ((index % cols) + cols) % cols;
  const row = Math.floor(Math.max(0, index) / cols);
  const left = grid + col * cellW;
  const top = grid + row * cellH;
  return { x: left + w / 2, y: top + h / 2 };
}

/** True when two centre-based boxes overlap, including a one-cell gutter. */
export function boxesOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  gap = FLOOR_GRID,
): boolean {
  const al = ax - aw / 2;
  const at = ay - ah / 2;
  const ar = ax + aw / 2;
  const ab = ay + ah / 2;
  const bl = bx - bw / 2 - gap;
  const bt = by - bh / 2 - gap;
  const br = bx + bw / 2 + gap;
  const bb = by + bh / 2 + gap;
  return al < br && ar > bl && at < bb && ab > bt;
}

/** First packed cell that does not collide with occupied centre-based boxes. */
export function firstFreeOnGrid(
  occupied: Array<{ x: number; y: number; w: number; h: number }>,
  w: number,
  h: number,
  roomW = FLOOR_ROOM_W,
  grid = FLOOR_GRID,
): { x: number; y: number } {
  const max = 256;
  for (let i = 0; i < max; i++) {
    const p = packOnGrid(i, w, h, roomW, grid);
    const hit = occupied.some((o) =>
      boxesOverlap(p.x, p.y, w, h, o.x, o.y, o.w, o.h, grid),
    );
    if (!hit) return p;
  }
  return packOnGrid(occupied.length, w, h, roomW, grid);
}
