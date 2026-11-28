/**
 * Tips on a payment.
 *
 * `Payment.tip` existed but nothing wrote it, so a tip was either rung up
 * as a sale line (taxed and filed as revenue) or kept off the books. A tip
 * is now part of the payment, never of the sale: it is stored in
 * `Payment.tip`, left out of the sale total, the VAT base and the tax
 * invoice, and reported on its own (by method and by waiter).
 *
 * The Pay screen sends `tipAmount` (in the venue's currency) or
 * `tipPercent` (of the bill), and for cash + card `tipMethod`. The till
 * turns that into `meta.tip = { amount, method }`.
 */
import { roundMoney } from './money';

export const INVALID_TIP = 'INVALID_TIP';

export type TipMethod = 'CASH' | 'CARD';
export interface PaymentTip {
  amount: number;
  method: TipMethod;
  /** As typed, when the tip was given as a percentage of the bill. */
  percent?: number;
}

/** A tip larger than the bill is almost always a typo (500 for 5.00). */
export const MAX_TIP_SHARE = 1;

const upper = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toUpperCase();

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * The payment `meta` with its tip made exact, or why it cannot be taken.
 * No tip: `tip` is removed so nothing downstream reads a stale one.
 */
export function normalizeTip(
  meta: Record<string, any>,
): { ok: true; meta: Record<string, any> } | { ok: false; error: string } {
  const m = { ...(meta || {}) };
  const total = roundMoney(Number(m.totalAfter) || 0);
  const percent = num(m.tipPercent);
  const typed = num(m.tipAmount ?? m.tip?.amount);
  delete m.tipAmount;
  delete m.tipPercent;
  const requestedMethod = upper(m.tipMethod ?? m.tip?.method);
  delete m.tipMethod;
  delete m.tip;

  let amount = 0;
  if (typed != null) amount = typed;
  else if (percent != null) amount = (total * percent) / 100;
  if (percent != null && (percent < 0 || percent > MAX_TIP_SHARE * 100)) {
    return {
      ok: false,
      error:
        'The tip percentage must be between 0 and 100. Check it and charge again.',
    };
  }
  amount = roundMoney(amount);
  if (amount < 0) {
    return {
      ok: false,
      error: 'A tip cannot be negative. Check it and charge again.',
    };
  }
  if (amount === 0) return { ok: true, meta: m };
  if (total > 0 && amount > roundMoney(total * MAX_TIP_SHARE)) {
    return {
      ok: false,
      error:
        'The tip is more than the bill. Check the amount and charge again.',
    };
  }
  const method = upper(m.method || m.paymentMethod);
  let tipMethod: TipMethod;
  if (method === 'CASH') tipMethod = 'CASH';
  else if (method === 'CARD') tipMethod = 'CARD';
  else if (method === 'MIXED')
    tipMethod = requestedMethod === 'CASH' ? 'CASH' : 'CARD';
  else {
    return {
      ok: false,
      error: 'A tip can be taken with cash or card only.',
    };
  }
  m.tip = {
    amount,
    method: tipMethod,
    ...(percent != null && typed == null ? { percent } : {}),
  } satisfies PaymentTip;
  return { ok: true, meta: m };
}

/** The tip stored on a payment's meta, or null. */
export function tipOf(meta: unknown): PaymentTip | null {
  const t = (meta as any)?.tip;
  const amount = roundMoney(Number(t?.amount) || 0);
  if (!(amount > 0)) return null;
  const method: TipMethod = upper(t?.method) === 'CASH' ? 'CASH' : 'CARD';
  return { amount, method };
}

export interface TipTotals {
  total: number;
  count: number;
  byMethod: Array<{ method: TipMethod; amount: number; count: number }>;
  byWaiter: Array<{
    userId: number | null;
    name: string;
    amount: number;
    count: number;
  }>;
}

/** Tips summed by method and by waiter, in whole cents (they reconcile). */
export function sumTips(
  rows: Array<{
    tip: unknown;
    meta?: unknown;
    userId?: number | null;
    userName?: string | null;
  }>,
): TipTotals {
  const c = (n: number) => Math.round(n * 100);
  let total = 0;
  let count = 0;
  const byMethod = new Map<TipMethod, { amount: number; count: number }>();
  const byWaiter = new Map<
    string,
    { userId: number | null; name: string; amount: number; count: number }
  >();
  for (const r of rows) {
    const stored = c(Number(r.tip) || 0);
    if (!(stored > 0)) continue;
    const method = tipOf(r.meta)?.method ?? 'CARD';
    total += stored;
    count += 1;
    const m = byMethod.get(method) ?? { amount: 0, count: 0 };
    m.amount += stored;
    m.count += 1;
    byMethod.set(method, m);
    const uid = Number(r.userId);
    const userId = Number.isInteger(uid) && uid > 0 ? uid : null;
    const key = String(userId ?? `name:${r.userName || ''}`);
    const w = byWaiter.get(key) ?? {
      userId,
      name: String(r.userName || '').trim() || (userId ? `#${userId}` : '—'),
      amount: 0,
      count: 0,
    };
    w.amount += stored;
    w.count += 1;
    byWaiter.set(key, w);
  }
  return {
    total: total / 100,
    count,
    byMethod: [...byMethod.entries()]
      .map(([method, v]) => ({
        method,
        amount: v.amount / 100,
        count: v.count,
      }))
      .sort((a, b) => a.method.localeCompare(b.method)),
    byWaiter: [...byWaiter.values()]
      .map((w) => ({ ...w, amount: w.amount / 100 }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/**
 * What the guest is charged: the bill plus the tip. The Pay button showed
 * the bill alone, so a waiter charged the card without the tip.
 */
export function chargeWithTip(bill: number, tip: number): number {
  const b = Number(bill) || 0;
  const t = Number(tip) > 0 ? Number(tip) : 0;
  return roundMoney(b + t);
}
