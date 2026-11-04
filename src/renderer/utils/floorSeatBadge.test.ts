/** QA v0.2.104 #15: a round table's seat count stays inside the circle. */
import { describe, expect, it } from 'vitest';

import { seatBadgeInset } from './floorSeatBadge';

/** Is the point (x, y), from the top-left of a w × h box, inside its ellipse? */
const insideEllipse = (x: number, y: number, w: number, h: number) =>
  ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1;

describe('seat badge on the floor plan', () => {
  it('every corner of the count is inside a round table, at every size', () => {
    // The count is about 12 × 10 px ("12" at 10 px).
    const bw = 12;
    const bh = 10;
    for (const size of [44, 56, 64, 80, 96, 120]) {
      const { right, bottom } = seatBadgeInset('circle', size, size);
      const x1 = size - right;
      const y1 = size - bottom;
      for (const [x, y] of [
        [x1, y1],
        [x1 - bw, y1],
        [x1, y1 - bh],
        [x1 - bw, y1 - bh],
      ]) {
        expect(insideEllipse(x, y, size, size)).toBe(true);
      }
    }
  });

  it('square and rectangular tables keep the corner placement', () => {
    expect(seatBadgeInset('square', 64, 64)).toEqual({ right: 4, bottom: 3 });
    expect(seatBadgeInset('rect', 100, 56)).toEqual({ right: 4, bottom: 3 });
  });
});
