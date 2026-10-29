import { formatMoneyPlain } from '@shared/receiptFigures';
import { formatMoney } from '@shared/paymentDisplay';
/** Amount text (no currency), grouped, always two decimals. */
export function makeFormatAmount() {
  return (n: number) =>
    formatMoneyPlain(Number.isFinite(n) ? n : 0, ',', { cents: true });
}

/** Euro amount for dual-currency totals, two decimals like every other amount. */
export function formatEur(amount: number): string {
  return formatMoney(amount, 'EUR');
}

/** Format a number with at most `maxFractionDigits` decimal places (avoids float noise). */
export function formatNumberMaxDecimals(
  n: number,
  maxFractionDigits = 1,
): string {
  if (!Number.isFinite(n)) return '—';
  const factor = 10 ** maxFractionDigits;
  const rounded = Math.round(n * factor) / factor;
  return rounded.toLocaleString(undefined, {
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: 0,
  });
}

/** Kept for its callers (floor tiles, review); same format as everywhere. */
export function formatMoneyCompact(currency: string, amount: number) {
  return formatMoney(amount, currency);
}
