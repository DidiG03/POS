/**
 * Cash handed over, and the change.
 *
 * The Pay screen sent `amountPaid` as the bill rounded to a whole unit,
 * not what the guest handed over, so the change was never recorded or
 * printed. It now sends `cashTendered` (what the waiter typed in "Cash
 * received"). The sale is still the bill; the tendered cash and the change
 * are kept beside it (Payment.change, `meta.cashTendered` /
 * `meta.cashChange`) and printed on the receipt. Z totals stay on the bill.
 */
import { roundMoney } from './money';
import { tipOf } from './tips';

const upper = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toUpperCase();

export interface CashTender {
  /** Cash the guest owed: the cash part of the bill, plus a cash tip. */
  due: number;
  /** Cash handed over. */
  tendered: number;
  change: number;
}

/** The cash owed on this payment: its cash part plus a cash tip. */
export function cashDueOf(meta: Record<string, any> | null | undefined) {
  const m = meta || {};
  const method = upper(m.method || m.paymentMethod);
  const total = Number(m.totalAfter) || 0;
  let cash = 0;
  if (method === 'CASH') cash = total;
  else if (method === 'MIXED' && Array.isArray(m.splits)) {
    cash = m.splits
      .filter((s: any) => upper(s?.method) === 'CASH')
      .reduce((a: number, s: any) => a + (Number(s?.amount) || 0), 0);
  }
  const tip = tipOf(m);
  if (tip?.method === 'CASH' && (method === 'CASH' || method === 'MIXED')) {
    cash += tip.amount;
  }
  return roundMoney(cash);
}

/**
 * What was handed over and the change, or null when no cash was owed or
 * nothing usable was typed. `cashTendered` is what the waiter typed; an
 * older app's `amountPaid` (the bill rounded) counts only when it covers
 * what was owed.
 */
export function cashTenderOf(
  meta: Record<string, any> | null | undefined,
): CashTender | null {
  const due = cashDueOf(meta);
  if (!(due > 0)) return null;
  const typed = Number(meta?.cashTendered);
  const legacy = Number(meta?.amountPaid);
  const tendered =
    Number.isFinite(typed) && typed > 0
      ? typed
      : Number.isFinite(legacy) && legacy > 0
        ? legacy
        : NaN;
  if (!Number.isFinite(tendered) || tendered + 1e-9 < due) return null;
  return {
    due,
    tendered: roundMoney(tendered),
    change: roundMoney(tendered - due),
  };
}

/** `meta` with the tendered cash and change written on it (for the receipt). */
export function withCashTender(meta: Record<string, any>): Record<string, any> {
  const t = cashTenderOf(meta);
  const out = { ...meta };
  delete out.cashChange;
  if (!t) {
    delete out.cashTendered;
    return out;
  }
  out.cashTendered = t.tendered;
  out.cashChange = t.change;
  return out;
}
