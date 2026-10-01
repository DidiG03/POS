/**
 * Change calculator on the payment screen: the cashier types what the
 * customer handed over and sees the change. Display only — nothing here is
 * stored or sent with the payment.
 */

/** Notes and coins worth suggesting as one-tap "customer gave" amounts. */
const DENOMINATIONS: Record<'ALL' | 'EUR', number[]> = {
  ALL: [100, 200, 500, 1000, 2000, 5000, 10000],
  EUR: [5, 10, 20, 50, 100, 200],
};

/** "1.000", "1 000", "12,5" → number; empty or unreadable → null. */
export function parseCashInput(raw: string): number | null {
  let s = String(raw || '')
    .trim()
    .replace(/[\s']/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal mark.
    const decimal = lastComma > lastDot ? ',' : '.';
    s = s
      .split(decimal === ',' ? '.' : ',')
      .join('')
      .replace(decimal, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const mark = lastComma >= 0 ? ',' : '.';
    const parts = s.split(mark);
    // 1.000 / 1,000 / 10.000.000 are thousands groups; 12,5 is a decimal.
    const grouped =
      parts.length > 2 || (parts.length === 2 && parts[1].length === 3);
    s = grouped ? parts.join('') : parts.join('.');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Change for `due` when the customer gives `received` (both in the till's
 * currency). Negative `short` means nothing; a short payment reports how
 * much is still missing instead.
 */
export function cashChange(
  due: number,
  received: number | null,
): { change: number; short: number } | null {
  if (received == null || !Number.isFinite(received) || received <= 0) {
    return null;
  }
  const diff = round2(received - Math.max(0, due));
  return diff >= 0
    ? { change: diff, short: 0 }
    : { change: 0, short: round2(-diff) };
}

/**
 * Up to `limit` round amounts above `due` a customer is likely to hand over
 * (e.g. 500 Lek due → 600, 1000, 2000).
 */
export function quickCashAmounts(
  due: number,
  currency: 'ALL' | 'EUR',
  limit = 3,
): number[] {
  if (!Number.isFinite(due) || due <= 0) return [];
  const out = new Set<number>();
  for (const note of DENOMINATIONS[currency]) {
    const amount = Math.ceil(due / note - 1e-9) * note;
    if (amount > due + 1e-9) out.add(amount);
  }
  return [...out].sort((a, b) => a - b).slice(0, limit);
}
