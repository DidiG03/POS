import { describe, expect, it } from 'vitest';
import {
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
});
