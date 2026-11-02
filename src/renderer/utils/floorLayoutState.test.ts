import { describe, expect, it } from 'vitest';
import {
  TABLE_CHROME_PX,
  computeFloorViewTransform,
  FLOOR_VIEW_IDENTITY,
  isFloorCanvasFitReady,
  isFloorLayoutPending,
  isFloorLayoutVacant,
  MAX_FIT_TABLE_PX,
  resolveFloorFitPadding,
  seatsInvalid,
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

  it('does not blow a lone table up to fill the view', () => {
    const view = computeFloorViewTransform({
      canvasW: 1200,
      canvasH: 800,
      nodes: [{ x: 200, y: 200, w: 80, h: 80 }],
      fitPadding: 24,
    });
    expect(view.scale * 80).toBeLessThanOrEqual(MAX_FIT_TABLE_PX + 0.001);
    // Still centred in the canvas.
    expect(view.tx + 200 * view.scale).toBeCloseTo(600, 3);
    expect(view.ty + 200 * view.scale).toBeCloseTo(400, 3);
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

  it('keeps every edge table on screen on a phone, chrome included (QA v0.2.103)', () => {
    // Tall layout on a portrait phone: width-fill used to push the top and
    // bottom rows past the canvas, where nothing could reach them.
    const nodes = [
      { x: 100, y: 80, w: 64, h: 64 },
      { x: 280, y: 80, w: 64, h: 64 },
      { x: 100, y: 520, w: 64, h: 64 },
      { x: 280, y: 520, w: 64, h: 64 },
    ];
    const pad = { x: 8, y: 88 };
    const W = 390;
    const H = 720;
    const view = computeFloorViewTransform({
      canvasW: W,
      canvasH: H,
      nodes,
      fitPadding: pad,
    });
    for (const n of nodes) {
      const half = n.w / 2 + TABLE_CHROME_PX;
      const left = view.tx + (n.x - half) * view.scale;
      const right = view.tx + (n.x + half) * view.scale;
      const top = view.ty + (n.y - half) * view.scale;
      const bottom = view.ty + (n.y + half) * view.scale;
      expect(left).toBeGreaterThanOrEqual(pad.x - 0.001);
      expect(right).toBeLessThanOrEqual(W - pad.x + 0.001);
      expect(top).toBeGreaterThanOrEqual(pad.y - 0.001);
      expect(bottom).toBeLessThanOrEqual(H - pad.y + 0.001);
    }
  });

  it('still fills the phone width when the plan fits', () => {
    // A wide, short plan: width is the tighter side.
    const nodes = [
      { x: 0, y: 100, w: 64, h: 64 },
      { x: 600, y: 100, w: 64, h: 64 },
    ];
    const view = computeFloorViewTransform({
      canvasW: 390,
      canvasH: 720,
      nodes,
      fitPadding: { x: 8, y: 88 },
    });
    const contentW = 600 + 64 + 2 * TABLE_CHROME_PX;
    expect(view.scale).toBeCloseTo((390 - 16) / contentW, 5);
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

  it('requires at least one seat once seats are set', () => {
    expect(seatsInvalid(undefined)).toBe(false);
    expect(seatsInvalid(1)).toBe(false);
    expect(seatsInvalid(0)).toBe(true);
    expect(seatsInvalid(-2)).toBe(true);
  });
});
