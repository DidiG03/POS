import { describe, expect, it } from 'vitest';
import {
  FLOOR_GRID,
  firstFreeOnGrid,
  packOnGrid,
  snapCenter,
  snapGrid,
  snapNodeCenter,
  snapSize,
} from './floorGrid';

describe('floorGrid', () => {
  it('snaps values onto the block grid', () => {
    expect(snapGrid(0)).toBe(0);
    expect(snapGrid(7)).toBe(0);
    expect(snapGrid(8)).toBe(16);
    expect(snapGrid(24)).toBe(32);
  });

  it('aligns bounding-box edges, not just the centre', () => {
    // 64×64 table: centre 40 → top-left 8, which rounds to 16, so centre 48.
    expect(snapCenter(40, 40, 64, 64)).toEqual({ x: 48, y: 48 });
    expect(snapCenter(50, 18, 96, 64)).toEqual({ x: 48, y: 16 });
    // Already on-grid stays put.
    expect(snapCenter(32, 32, 64, 64)).toEqual({ x: 32, y: 32 });
  });

  it('snaps sizes up to a whole cell', () => {
    expect(snapSize(64)).toBe(64);
    expect(snapSize(70)).toBe(64);
    expect(snapSize(8)).toBe(16);
    expect(snapSize(4)).toBe(FLOOR_GRID);
  });

  it('packs tables in left-to-right rows with a gutter', () => {
    const a = packOnGrid(0, 64, 64);
    const b = packOnGrid(1, 64, 64);
    expect(a).toEqual({ x: 16 + 32, y: 16 + 32 });
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBe(a.y);
    expect(b.x - a.x).toBe(64 + FLOOR_GRID);
  });

  it('snapNodeCenter uses TABLE default size when omitted', () => {
    expect(snapNodeCenter({ x: 40, y: 40 })).toEqual({ x: 48, y: 48 });
  });

  it('skips packed cells that already have a table', () => {
    const first = packOnGrid(0, 64, 64);
    const next = firstFreeOnGrid([{ ...first, w: 64, h: 64 }], 64, 64);
    expect(next).toEqual(packOnGrid(1, 64, 64));
  });
});
