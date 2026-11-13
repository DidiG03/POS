/**
 * Tables left open too long.
 *
 * The till used to void the unpaid lines of any table open for more than
 * 12 hours, every hour, with no approval and no setting: a table left open
 * with the cash kept only needed time to disappear, and a genuine long tab
 * was wiped too. The default is now to tell the admins and the table's
 * waiter, once per sitting, and leave the table for a person to close or
 * void (which is recorded like any other void). Venues that want the old
 * behaviour can turn it back on, and the limit is theirs to set.
 */
import { roundMoney } from '@shared/money';

export type OverdueTablesAction = 'remind' | 'void';

export interface OverdueTablesConfig {
  /** Hours a table may stay open before it is overdue. */
  hours: number;
  action: OverdueTablesAction;
}

export const OVERDUE_TABLES_DEFAULT_HOURS = 12;
export const OVERDUE_TABLES_MIN_HOURS = 1;
export const OVERDUE_TABLES_MAX_HOURS = 72;
export const OVERDUE_REMINDED_KEY = 'tables:overdueReminded';

export function overdueTablesConfig(settings: unknown): OverdueTablesConfig {
  const raw = (settings as any)?.preferences?.overdueTables || {};
  const hours = Number(raw.hours);
  return {
    hours:
      Number.isFinite(hours) &&
      hours >= OVERDUE_TABLES_MIN_HOURS &&
      hours <= OVERDUE_TABLES_MAX_HOURS
        ? hours
        : OVERDUE_TABLES_DEFAULT_HOURS,
    action: raw.action === 'void' ? 'void' : 'remind',
  };
}

/** Why a saved `preferences.overdueTables` cannot be used, or null. */
export function overdueTablesProblem(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return 'Overdue tables: not a setting.';
  const r = raw as Record<string, unknown>;
  if (r.hours !== undefined) {
    const h = Number(r.hours);
    if (
      !Number.isFinite(h) ||
      h < OVERDUE_TABLES_MIN_HOURS ||
      h > OVERDUE_TABLES_MAX_HOURS
    ) {
      return `Overdue tables: hours must be between ${OVERDUE_TABLES_MIN_HOURS} and ${OVERDUE_TABLES_MAX_HOURS}.`;
    }
  }
  if (r.action !== undefined && r.action !== 'remind' && r.action !== 'void') {
    return 'Overdue tables: the action must be "remind" or "void".';
  }
  return null;
}

export interface OverdueTable {
  area: string;
  label: string;
  openedAt: Date;
}

export function overdueTables(
  occupied: OverdueTable[],
  hours: number,
  nowMs: number,
): OverdueTable[] {
  const cutoff = hours * 60 * 60 * 1000;
  return occupied.filter(
    (t) =>
      t.openedAt instanceof Date &&
      Number.isFinite(t.openedAt.getTime()) &&
      nowMs - t.openedAt.getTime() > cutoff,
  );
}

type Line = {
  qty?: unknown;
  unitPrice?: unknown;
  voided?: unknown;
  paid?: unknown;
};

/** What is still owed on the lines (not voided, not paid). */
export function unpaidAmount(lines: unknown): number {
  let sum = 0;
  for (const l of Array.isArray(lines) ? (lines as Line[]) : []) {
    if (!l || l.voided === true || l.paid === true) continue;
    const qty = Number(l.qty ?? 1);
    const price = Number(l.unitPrice ?? 0);
    if (Number.isFinite(qty) && Number.isFinite(price)) sum += qty * price;
  }
  return roundMoney(sum);
}

export function overdueTableMessage(input: {
  area: string;
  label: string;
  hours: number;
  amount: number;
  currency: string;
}): string {
  const money = `${input.amount.toFixed(2)} ${input.currency}`.trim();
  return (
    `Table ${input.area} ${input.label} has been open for more than ${input.hours} hours` +
    (input.amount > 0 ? ` with ${money} unpaid` : ' with nothing unpaid') +
    '. Close it, take the payment, or void it with a reason. It will not be closed automatically.'
  );
}

/** The sittings already reminded about: table key → openedAt (ISO). */
export type RemindedMap = Record<string, string>;

export function tableKey(area: string, label: string): string {
  return `${area}:${label}`;
}

export function alreadyReminded(map: RemindedMap, t: OverdueTable): boolean {
  return map[tableKey(t.area, t.label)] === t.openedAt.toISOString();
}

/** Keep only the entries for tables that are still open. */
export function pruneReminded(
  map: RemindedMap,
  occupied: OverdueTable[],
): RemindedMap {
  const live = new Set(occupied.map((t) => tableKey(t.area, t.label)));
  const out: RemindedMap = {};
  for (const [k, v] of Object.entries(map)) if (live.has(k)) out[k] = v;
  return out;
}
