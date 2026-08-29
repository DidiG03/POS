import { roundMoney } from './pricing';

/** Fiscal "Kursi EUR" is ALL per 1 EUR. */
export function parseEurExchangeRate(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Convert a POS amount using the fiscal ALL-per-EUR rate.
 * Only ALL ↔ EUR is defined — other POS currencies return nulls.
 */
export function convertPosAmount(
  amount: number,
  posCurrency: string,
  allPerEur: number | null,
): { eur: number | null; all: number | null } {
  const n = Number(amount);
  if (!Number.isFinite(n)) return { eur: null, all: null };
  const cur = String(posCurrency || '')
    .trim()
    .toUpperCase();
  const rate =
    allPerEur != null && Number.isFinite(allPerEur) && allPerEur > 0
      ? allPerEur
      : null;

  if (cur === 'EUR') {
    return { eur: n, all: rate != null ? roundMoney(n * rate) : null };
  }
  if (cur === 'ALL' || cur === 'LEK') {
    return { eur: rate != null ? roundMoney(n / rate) : null, all: n };
  }
  return { eur: null, all: null };
}

/**
 * Waiter-facing euro quote: POS amounts ÷ fiscal Kursi EUR (ALL per 1 EUR).
 * Used on the payment screen so guests paying in euro hear a real figure.
 */
export function toEurAtRate(
  amount: number,
  allPerEur: number | null,
): number | null {
  const n = Number(amount);
  const rate = parseEurExchangeRate(allPerEur);
  if (!Number.isFinite(n) || rate == null) return null;
  return roundMoney(n / rate);
}

export function splitEvenly(
  total: number,
  guests: number,
): { guests: number; perPerson: number; lastPerson: number } | null {
  const g = Math.floor(Number(guests));
  if (!Number.isFinite(g) || g < 1) return null;
  const t = Number(total);
  if (!Number.isFinite(t) || t < 0) return null;
  const perPerson = roundMoney(t / g);
  const lastPerson = roundMoney(t - perPerson * (g - 1));
  return { guests: g, perPerson, lastPerson };
}

export function cashChangeDue(tendered: number, due: number): number {
  const paid = Number(tendered);
  const d = Number(due);
  if (!Number.isFinite(paid) || !Number.isFinite(d)) return 0;
  return roundMoney(Math.max(0, paid - d));
}

/** Touch-friendly cash denominations for the till. */
export function cashTenderSuggestions(
  due: number,
  posCurrency: string,
): number[] {
  const d = Number(due);
  if (!Number.isFinite(d) || d <= 0) return [];
  const cur = String(posCurrency || '')
    .trim()
    .toUpperCase();
  const out: number[] = [];
  const add = (v: number) => {
    const r = roundMoney(v);
    if (r + 1e-9 < d) return;
    if (out.some((x) => Math.abs(x - r) < 1e-9)) return;
    out.push(r);
  };
  add(d);
  if (cur === 'ALL' || cur === 'LEK') {
    add(Math.ceil(d / 500) * 500);
    add(Math.ceil(d / 1000) * 1000);
    add(Math.ceil(d / 5000) * 5000);
  } else if (cur === 'EUR') {
    add(Math.ceil(d / 5) * 5);
    add(Math.ceil(d / 10) * 10);
    add(Math.ceil(d / 20) * 20);
    add(Math.ceil(d / 50) * 50);
  } else {
    add(Math.ceil(d));
  }
  return out.slice(0, 4);
}
