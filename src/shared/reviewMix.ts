/** Histogram edges for ticket-size charts. Independent of currency. */

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(n));
  const f = n / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Width of each of four buckets, from the largest ticket. */
export function ticketSizeStep(maxTotal: number): number {
  const top = niceCeil(Math.max(0, maxTotal));
  return Math.max(1, niceCeil(top / 4));
}

export type TicketSizeBucket = {
  /** Inclusive. */
  min: number;
  /** Exclusive. Null = open-ended last bucket. */
  max: number | null;
  orders: number;
  revenue: number;
};

/**
 * Four buckets covering every ticket. `orders` and `revenue` always
 * partition the input — nothing is dropped or double-counted.
 */
export function buildTicketSizeBuckets(totals: number[]): TicketSizeBucket[] {
  const clean = totals.map((n) => (Number.isFinite(n) && n > 0 ? n : 0));
  const max = clean.reduce((m, n) => (n > m ? n : m), 0);
  const step = ticketSizeStep(max);
  const buckets: TicketSizeBucket[] = [
    { min: 0, max: step, orders: 0, revenue: 0 },
    { min: step, max: step * 2, orders: 0, revenue: 0 },
    { min: step * 2, max: step * 3, orders: 0, revenue: 0 },
    { min: step * 3, max: null, orders: 0, revenue: 0 },
  ];
  for (const total of clean) {
    const i =
      total < step ? 0 : total < step * 2 ? 1 : total < step * 3 ? 2 : 3;
    buckets[i].orders += 1;
    buckets[i].revenue += total;
  }
  return buckets;
}

export function spendPerCover(revenueGross: number, covers: number): number {
  if (!(covers > 0) || !Number.isFinite(revenueGross)) return 0;
  return revenueGross / covers;
}
