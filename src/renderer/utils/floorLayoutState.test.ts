import { describe, expect, it } from 'vitest';
import {
  computeFloorViewTransform,
  FLOOR_VIEW_IDENTITY,
  isFloorCanvasFitReady,
  isFloorLayoutPending,
  isFloorLayoutVacant,
  resolveFloorFitPadding,
} from './floorLayoutState';

describe('floorLayoutState', () => {
  it('treats null as loading, not as an empty area', () => {
    expect(isFloorLayoutPending(null)).toBe(true);
    expect(isFloorLayoutVacant(null)).toBe(false);
  });

  it('treats a loaded empty list as the vacant-area state', () => {
    expect(isFloorLayoutPending([])).toBe(false);
    expect(isFloorLayoutVacant([])).toBe(true);
  });

  it('treats a loaded layout as neither loading nor vacant', () => {
    const nodes = [{ id: 1 }];
    expect(isFloorLayoutPending(nodes)).toBe(false);
    expect(isFloorLayoutVacant(nodes)).toBe(false);
  });

  it('waits for a measured canvas before the auto-fit paint', () => {
    expect(isFloorCanvasFitReady({ w: 0, h: 0 })).toBe(false);
    expect(isFloorCanvasFitReady({ w: 360, h: 0 })).toBe(false);
    expect(isFloorCanvasFitReady({ w: 360, h: 520 })).toBe(true);
  });

  it('resolves asymmetric fit padding for waiter overlays', () => {
    expect(resolveFloorFitPadding(72)).toEqual({ x: 72, y: 72 });
    expect(resolveFloorFitPadding({ x: 8, y: 88 })).toEqual({ x: 8, y: 88 });
  });

  it('fits the floor uniformly so wide desktops do not stretch gaps', () => {
    const nodes = [
      { x: 100, y: 100, w: 80, h: 80 },
      { x: 300, y: 500, w: 80, h: 80 },
    ];
    const phone = computeFloorViewTransform({
      canvasW: 390,
      canvasH: 700,
      nodes,
      fitPadding: { x: 8, y: 88 },
    });
    const desktop = computeFloorViewTransform({
      canvasW: 1400,
      canvasH: 800,
      nodes,
      fitPadding: 72,
    });
    expect(phone.scaleX).toBeCloseTo(phone.scaleY, 5);
    expect(phone.scaleX).toBeCloseTo(phone.scale, 5);
    expect(desktop.scaleX).toBeCloseTo(desktop.scaleY, 5);
    expect(desktop.scaleX).toBeCloseTo(desktop.scale, 5);
    // Wide canvas must not inflate X beyond Y (the old non-uniform stretch).
    expect(desktop.scaleX / desktop.scaleY).toBeCloseTo(1, 5);
  });

  it('fills phone width instead of leaving empty side bands', () => {
    // Tall layout on a portrait phone: old contain-fit letterboxed the
    // sides. Width-first should use ~full canvas width (minus padX).
    const nodes = [
      { x: 100, y: 80, w: 64, h: 64 },
      { x: 280, y: 80, w: 64, h: 64 },
      { x: 100, y: 520, w: 64, h: 64 },
      { x: 280, y: 520, w: 64, h: 64 },
    ];
    const phone = computeFloorViewTransform({
      canvasW: 390,
      canvasH: 720,
      nodes,
      fitPadding: { x: 8, y: 88 },
    });
    const contentW = 280 - 100 + 64; // maxX-minX with half extents ≈ 244
    // Scale should be close to width-fill, not height-contain.
    const widthFill = (390 - 16) / contentW;
    expect(phone.scale).toBeGreaterThan(1.2);
    expect(phone.scale).toBeCloseTo(Math.min(widthFill, 5), 1);
  });

  it('returns identity when the canvas is not measured yet', () => {
    expect(
      computeFloorViewTransform({
        canvasW: 0,
        canvasH: 0,
        nodes: [{ x: 10, y: 10, w: 64, h: 64 }],
      }),
    ).toEqual(FLOOR_VIEW_IDENTITY);
  });
});
