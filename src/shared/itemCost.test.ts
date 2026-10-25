import { describe, expect, it } from 'vitest';
import {
  costWritePayload,
  itemCostFigures,
  parseCostBreakdown,
  resolveUnitCost,
  sanitizeCostBreakdown,
  sumCostLines,
} from './itemCost';

describe('itemCost', () => {
  it('sums a breakdown and prefers it over a stale costPrice', () => {
    const lines = parseCostBreakdown([
      { id: 'a', label: 'Buy', amount: 200 },
      { id: 'b', label: 'Pack', amount: 20 },
    ]);
    expect(sumCostLines(lines)).toBe(220);
    expect(resolveUnitCost(999, lines)).toBe(220);
  });

  it('falls back to costPrice when there are no lines', () => {
    expect(resolveUnitCost(80, [])).toBe(80);
    expect(resolveUnitCost(null, [])).toBeNull();
  });

  it('parses a JSON string from SQLite', () => {
    const lines = parseCostBreakdown(
      JSON.stringify([{ id: 'x', label: 'Buy', amount: 40 }]),
    );
    expect(lines).toEqual([{ id: 'x', label: 'Buy', amount: 40 }]);
  });

  it('drops empty lines and writes a summed cost', () => {
    const payload = costWritePayload(
      sanitizeCostBreakdown([
        { id: 'a', label: 'Buy', amount: 80 },
        { id: 'b', label: '', amount: 0 },
        { id: 'c', label: 'Box', amount: 5 },
      ]),
    );
    expect(payload.costPrice).toBe(85);
    expect(payload.costBreakdown).toHaveLength(2);
  });

  it('computes profit, margin, markup, and stock value', () => {
    const f = itemCostFigures({ sellPrice: 400, cost: 250, onHand: 4 });
    expect(f.profit).toBe(150);
    expect(f.marginPct).toBeCloseTo(37.5);
    expect(f.markupPct).toBeCloseTo(60);
    expect(f.stockValue).toBe(1000);
    expect(f.stockProfit).toBe(600);
  });
});

describe('margins on a VAT-inclusive price', () => {
  it('measures profit on what the venue keeps after VAT', () => {
    const f = itemCostFigures({ sellPrice: 1200, cost: 600, vatRate: 0.2 });
    expect(f.profit).toBeCloseTo(400);
    expect(f.marginPct).toBeCloseTo(40);
    expect(f.markupPct).toBeCloseTo(66.67, 1);
  });

  it('keeps the gross price when no VAT applies', () => {
    const f = itemCostFigures({ sellPrice: 1200, cost: 600, vatRate: 0 });
    expect(f.profit).toBe(600);
  });
});
