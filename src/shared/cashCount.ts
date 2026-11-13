/**
 * Counting the cash at clock-out.
 *
 * A shift close printed each person's sales by payment method, but nobody
 * counted the cash they held, so a shortfall had no name on it. With
 * `preferences.cashCountAtClockOut` on, clocking out asks for the cash
 * counted, without showing the expected figure first (a blind count). The
 * till compares it with that person's cash sales for the shift.
 */
import { roundMoney } from './money';

export const CASH_COUNT_REQUIRED = 'CASH_COUNT_REQUIRED';
/** A difference smaller than this is rounding, not a shortfall. */
export const CASH_COUNT_TOLERANCE = 0.005;

export function cashCountAtClockOut(settings: unknown): boolean {
  return (settings as any)?.preferences?.cashCountAtClockOut === true;
}

/** The amount typed, or null when it is not a usable amount. */
export function parseCountedCash(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? roundMoney(n) : null;
}

export interface CashCount {
  expected: number;
  counted: number;
  /** counted − expected: negative is short, positive is over. */
  difference: number;
}

export function cashCountResult(expected: number, counted: number): CashCount {
  const e = roundMoney(expected);
  const c = roundMoney(counted);
  const d = roundMoney(c - e);
  return {
    expected: e,
    counted: c,
    difference: Math.abs(d) < CASH_COUNT_TOLERANCE ? 0 : d,
  };
}
