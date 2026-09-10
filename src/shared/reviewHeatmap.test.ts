import { describe, expect, it } from 'vitest';
import {
  emptyReviewHeatmap,
  heatmapHourRange,
  heatmapLevel,
  heatmapMaxOrders,
  heatmapThresholds,
  reviewHeatmapIndex,
} from './reviewHeatmap';

describe('reviewHeatmap', () => {
  it('indexes Sunday hour 0 as the first cell', () => {
    expect(reviewHeatmapIndex(0, 0)).toBe(0);
    expect(reviewHeatmapIndex(6, 23)).toBe(7 * 24 - 1);
    expect(emptyReviewHeatmap()).toHaveLength(168);
  });

  it('matches the 200 / 500 / 1,000 / 2,000 legend at a 2,000 peak', () => {
    expect(heatmapThresholds(2000)).toEqual([200, 500, 1000, 2000]);
  });

  it('keeps four increasing steps for a small venue', () => {
    const [a, b, c, d] = heatmapThresholds(8);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
  });

  it('treats zero as empty and maps counts onto four fills', () => {
    const t = heatmapThresholds(2000);
    expect(heatmapLevel(0, t)).toBe(0);
    expect(heatmapLevel(50, t)).toBe(1);
    expect(heatmapLevel(200, t)).toBe(1);
    expect(heatmapLevel(500, t)).toBe(2);
    expect(heatmapLevel(1000, t)).toBe(3);
    expect(heatmapLevel(2000, t)).toBe(4);
  });

  it('finds the occupied hour window', () => {
    const cells = emptyReviewHeatmap();
    cells[reviewHeatmapIndex(4, 9)].orders = 3;
    cells[reviewHeatmapIndex(4, 15)].orders = 1;
    expect(heatmapHourRange(cells)).toEqual({ start: 9, end: 15 });
    expect(heatmapMaxOrders(cells)).toBe(3);
    expect(heatmapHourRange(emptyReviewHeatmap())).toBeNull();
  });
});
