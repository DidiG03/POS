import { describe, expect, it } from 'vitest';
import {
  buildTicketSizeBuckets,
  spendPerCover,
  ticketSizeStep,
} from './reviewMix';

describe('ticketSizeStep', () => {
  it('uses 500-wide buckets when the largest ticket is 2,000', () => {
    expect(ticketSizeStep(2000)).toBe(500);
  });

  it('stays at least 1', () => {
    expect(ticketSizeStep(0)).toBe(1);
  });
});

describe('buildTicketSizeBuckets', () => {
  it('puts every ticket in exactly one bucket and preserves revenue', () => {
    const totals = [100, 600, 1140, 2000, 0];
    const buckets = buildTicketSizeBuckets(totals);
    expect(buckets).toHaveLength(4);
    expect(buckets.reduce((n, b) => n + b.orders, 0)).toBe(totals.length);
    expect(buckets.reduce((n, b) => n + b.revenue, 0)).toBe(
      totals.reduce((a, b) => a + b, 0),
    );
    // step 500: 100 → 0–500, 600 → 500–1000, 1140 → 1000–1500, 2000 → 1500+
    expect(buckets.map((b) => b.orders)).toEqual([2, 1, 1, 1]);
  });

  it('keeps a 1,140 ticket with a 540 sibling in the same 1,000–1,500 band', () => {
    const buckets = buildTicketSizeBuckets([1140, 540]);
    const mid = buckets.find((b) => b.min === 500 && b.max === 1000);
    const high = buckets.find((b) => b.min === 1000 && b.max === 1500);
    expect(mid?.orders).toBe(1);
    expect(mid?.revenue).toBe(540);
    expect(high?.orders).toBe(1);
    expect(high?.revenue).toBe(1140);
  });
});

describe('spendPerCover', () => {
  it('divides all receipt revenue by covers counted on the closing pay', () => {
    // Seat 600 + close 540, covers 4 → 285 each, not 540/4.
    expect(spendPerCover(1140, 4)).toBe(285);
  });

  it('is 0 when nobody was seated', () => {
    expect(spendPerCover(1140, 0)).toBe(0);
  });
});
