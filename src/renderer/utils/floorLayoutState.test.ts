import { describe, expect, it } from 'vitest';
import {
  computeFloorViewTransform,
  FLOOR_VIEW_IDENTITY,
  isFloorCanvasFitReady,
  isFloorLayoutPending,
  isFloorLayoutVacant,
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

  it('fits the floor uniformly so wide desktops do not stretch gaps', () => {
    const nodes = [
      { x: 100, y: 100, w: 80, h: 80 },
      { x: 300, y: 500, w: 80, h: 80 },
    ];
    const phone = computeFloorViewTransform({
      canvasW: 390,
      canvasH: 700,
      nodes,
      fitPadding: 24,
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
