/** Pure helpers for the Voids & discounts screen (`AdminBillEventsPage`). */
import type { BillEventDTO, BillEventKindDTO } from '@shared/ipc';

export type RangePreset = 'today' | 'yesterday' | 'last7' | 'last30';

export function rangeForPreset(
  preset: RangePreset,
  now: Date,
): { from: Date; to: Date } {
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const daysAgo = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d;
  };
  switch (preset) {
    case 'today':
      return { from: startOf(now), to: endOf(now) };
    case 'yesterday':
      return { from: startOf(daysAgo(1)), to: endOf(daysAgo(1)) };
    case 'last7':
      return { from: startOf(daysAgo(6)), to: endOf(now) };
    case 'last30':
    default:
      return { from: startOf(daysAgo(29)), to: endOf(now) };
  }
}

export type KindFilter =
  | 'ALL'
  | 'VOIDS'
  | 'DISCOUNT'
  | 'SERVICE_CHARGE_REMOVED'
  | 'PRICE_CORRECTED'
  | 'AUTO_VOID';

export const KIND_FILTERS: Record<KindFilter, BillEventKindDTO[] | null> = {
  ALL: null,
  VOIDS: ['VOID_ITEM', 'VOID_TICKET'],
  DISCOUNT: ['DISCOUNT'],
  SERVICE_CHARGE_REMOVED: ['SERVICE_CHARGE_REMOVED'],
  PRICE_CORRECTED: ['PRICE_CORRECTED'],
  AUTO_VOID: ['AUTO_VOID'],
};

export function billEventsTotals(rows: BillEventDTO[]): {
  count: number;
  amount: number;
} {
  let amount = 0;
  for (const r of rows) if (r.amount != null) amount += Number(r.amount) || 0;
  return { count: rows.length, amount: Math.round(amount * 100) / 100 };
}

type Line = { name?: unknown; qty?: unknown; unitPrice?: unknown };

function linesText(lines: unknown, max: number): string {
  const list = Array.isArray(lines) ? (lines as Line[]) : [];
  const parts = list
    .slice(0, max)
    .map((l) => `${Number(l?.qty) || 0} × ${String(l?.name || 'Item')}`);
  if (list.length > max) parts.push(`+${list.length - max}`);
  return parts.join(', ');
}

/** One line under the event: lines, reason, what was corrected. */
export function billEventSummary(r: BillEventDTO, full = false): string {
  const d = (r.details || {}) as Record<string, unknown>;
  const parts: string[] = [];
  const lines = linesText(d.lines, full ? 60 : 3);
  if (lines) parts.push(lines);
  if (r.kind === 'DISCOUNT' && d.discountType) {
    const v = d.discountValue;
    parts.push(
      d.discountType === 'PERCENT' ? `${v}%` : `${String(d.discountType)}`,
    );
  }
  if (r.reason) parts.push(full ? r.reason : r.reason.slice(0, 120));
  return parts.join(' · ');
}
