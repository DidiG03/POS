export type ItemCostLine = {
  id: string;
  label: string;
  amount: number;
};

export function newCostLineId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyCostLine(amount = 0, label = ''): ItemCostLine {
  return { id: newCostLineId(), label, amount };
}

export function parseCostBreakdown(raw: unknown): ItemCostLine[] {
  let value: unknown = raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: ItemCostLine[] = [];
  for (const row of value) {
    const r = row as { id?: unknown; label?: unknown; amount?: unknown };
    const amount = Number(r?.amount);
    if (!Number.isFinite(amount)) continue;
    out.push({
      id: String(r?.id || `c-${out.length}`),
      label: String(r?.label || '').trim(),
      amount,
    });
  }
  return out;
}

export function sumCostLines(lines: ItemCostLine[]): number {
  return lines.reduce(
    (n, line) => n + (Number.isFinite(line.amount) ? line.amount : 0),
    0,
  );
}

export function sanitizeCostBreakdown(lines: ItemCostLine[]): ItemCostLine[] {
  const out: ItemCostLine[] = [];
  for (const line of lines) {
    const amount = Number(line.amount);
    const label = String(line.label || '').trim();
    if (!Number.isFinite(amount)) continue;
    if (!label && amount === 0) continue;
    out.push({
      id: String(line.id || newCostLineId()),
      label,
      amount,
    });
  }
  return out;
}

export function costWritePayload(lines: ItemCostLine[]): {
  costPrice: number | null;
  costBreakdown: ItemCostLine[] | null;
} {
  const clean = sanitizeCostBreakdown(lines);
  if (!clean.length) return { costPrice: null, costBreakdown: null };
  return { costPrice: sumCostLines(clean), costBreakdown: clean };
}

export function seedCostLines(
  costPrice?: number | null,
  breakdown?: unknown,
): ItemCostLine[] {
  const parsed = parseCostBreakdown(breakdown);
  if (parsed.length) return parsed.map((line) => ({ ...line }));
  const n = costPrice == null ? null : Number(costPrice);
  return [emptyCostLine(n != null && Number.isFinite(n) ? n : 0)];
}

export function resolveUnitCost(
  costPrice: number | null | undefined,
  breakdown: unknown,
): number | null {
  const lines = parseCostBreakdown(breakdown);
  if (lines.length) {
    const sum = sumCostLines(lines);
    return Number.isFinite(sum) ? sum : null;
  }
  if (costPrice == null) return null;
  const n = Number(costPrice);
  return Number.isFinite(n) ? n : null;
}

export function itemCostFigures(input: {
  sellPrice: number;
  cost: number | null;
  onHand?: number | null;
}): {
  cost: number | null;
  profit: number | null;
  marginPct: number | null;
  markupPct: number | null;
  stockValue: number | null;
  stockProfit: number | null;
} {
  const sell = Number(input.sellPrice);
  const cost = input.cost;
  const hasSell = Number.isFinite(sell);
  const hasCost = cost != null && Number.isFinite(cost);
  const profit = hasSell && hasCost ? sell - cost : null;
  const marginPct =
    profit != null && hasSell && sell !== 0 ? (profit / sell) * 100 : null;
  const markupPct =
    profit != null && hasCost && cost !== 0 ? (profit / cost) * 100 : null;
  const onHand =
    input.onHand != null && Number.isFinite(Number(input.onHand))
      ? Math.max(0, Number(input.onHand))
      : null;
  return {
    cost: hasCost ? cost : null,
    profit,
    marginPct,
    markupPct,
    stockValue: hasCost && onHand != null ? cost * onHand : null,
    stockProfit: profit != null && onHand != null ? profit * onHand : null,
  };
}
